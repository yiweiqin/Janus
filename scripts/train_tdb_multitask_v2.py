"""Train/evaluate structured multitask TDB baseline on public inputs.

Offline gold is joined by id for supervision and evaluation.  Gold and hidden
world fields are never used to construct features.  The frozen test file is
not read by this command.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
from pathlib import Path

import numpy as np
from sklearn.ensemble import ExtraTreesClassifier, ExtraTreesRegressor
from sklearn.metrics import accuracy_score, mean_absolute_error, mean_squared_error

STRUCTURES = ["and_bottleneck", "or_redundancy", "cascade", "shared_resource", "version_coupling", "double_fault"]
EDGES = ["e0", "e1", "e2"]
ACTIONS = ["repair_e0", "repair_e1", "repair_both"]
UNITS = ["e0.status", "e1.status", "e2.status"]
STATUSES = ["SUPPORTED", "FAILED", "STALE", "UNKNOWN", "CONFLICT"]
RANDOM_SEED = 20260910
ABLATION = "none"


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def feature(row: dict) -> list[float]:
    obs = row["observable"]
    evidence = obs["evidence"]
    values: list[float] = []
    for edge in EDGES:
        item = evidence[edge]
        values.extend([
            -1.0 if item["primary"] is None else float(item["primary"]),
            -1.0 if item["secondary"] is None else float(item["secondary"]),
            float(item["missing"]), float(item["conflict"]), float(item["ageBucket"]),
        ])
    values.extend([0.0 if ABLATION == "no_interaction" else 1.0 if row["structure"]["kind"] == kind else 0.0 for kind in STRUCTURES])
    values.append(float(obs["riskBudget"]))
    return values


def fit_regressor(x, y):
    return ExtraTreesRegressor(n_estimators=240, random_state=RANDOM_SEED, min_samples_leaf=2, n_jobs=-1).fit(x, y)


def fit_classifier(x, y):
    values = sorted(set(y))
    if len(values) == 1:
        return ("constant", values[0])
    return ("model", ExtraTreesClassifier(n_estimators=240, random_state=RANDOM_SEED, min_samples_leaf=2, n_jobs=-1).fit(x, y))


def predict_classifier(model, x):
    return [model[1]] * len(x) if model[0] == "constant" else model[1].predict(x).tolist()


def metrics_regression(model, x, y):
    prediction = model.predict(x)
    return prediction, {"mae": float(mean_absolute_error(y, prediction)), "rmse": float(mean_squared_error(y, prediction) ** 0.5)}


def main() -> None:
    global RANDOM_SEED, ABLATION
    parser = argparse.ArgumentParser()
    parser.add_argument("--public", required=True)
    parser.add_argument("--gold", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--seed", type=int, default=20260910)
    parser.add_argument("--purpose", default="structured_baseline_replication")
    parser.add_argument("--ablation", choices=["none", "no_interaction", "no_cost"], default="none")
    args = parser.parse_args()
    RANDOM_SEED = args.seed; ABLATION = args.ablation
    public_path = Path(args.public)
    gold_path = Path(args.gold)
    public = load_jsonl(public_path)
    gold = load_jsonl(gold_path)
    gold_by_id = {row["id"]: row for row in gold}
    if set(gold_by_id) != {row["id"] for row in public}:
        raise ValueError("public_gold_id_mismatch")
    if any("hidden_world" in row or "worldCatalog" in row or "statePosterior" in row or "utilityGold" in row for row in public):
        raise ValueError("gold_or_hidden_truth_in_public_input")

    train = [row for row in public if row["split"] == "train"]
    development = [row for row in public if row["split"] == "development"]
    calibration = [row for row in public if row["split"] == "calibration"]
    if not train or not development or not calibration:
        raise ValueError("required_train_development_calibration_split_missing")
    x_train = np.asarray([feature(row) for row in train], dtype=float)
    x_dev = np.asarray([feature(row) for row in development], dtype=float)
    x_cal = np.asarray([feature(row) for row in calibration], dtype=float)
    report = {
        "scope": "synthetic_public_input_multitask_structured_baseline",
        "evidenceLevel": "SYNTHETIC_FINITE_WORLD_ONLY",
        "publicSha256": hashlib.sha256(public_path.read_bytes()).hexdigest(),
        "goldSha256": hashlib.sha256(gold_path.read_bytes()).hexdigest(),
        "testUsed": False,
        "seed": args.seed, "purpose": args.purpose, "ablation": args.ablation, "pid": os.getpid(), "hostname": socket.gethostname(),
        "counts": {"train": len(train), "development": len(development), "calibration": len(calibration)},
        "utilitySemantics": "task_success_without_cost; cost reported separately and applied once for policy selection",
    }

    predictions = []
    state_metrics = {}
    state_models = {}
    for edge in EDGES:
        target = [gold_by_id[row["id"]]["statePosterior"][edge] for row in train]
        dev_target = [gold_by_id[row["id"]]["statePosterior"][edge] for row in development]
        labels = [item["status"] for item in target]
        model = fit_classifier(x_train, labels)
        state_models[edge] = model
        status_prediction = predict_classifier(model, x_dev)
        state_metrics[edge] = {"statusAccuracy": float(accuracy_score([item["status"] for item in dev_target], status_prediction))}
        train_reg = [(index, item["posteriorMean"]) for index, item in enumerate(target) if item["posteriorMean"] is not None]
        dev_reg = [(index, item["posteriorMean"]) for index, item in enumerate(dev_target) if item["posteriorMean"] is not None]
        if train_reg and dev_reg:
            reg = fit_regressor(x_train[[index for index, _ in train_reg]], np.asarray([value for _, value in train_reg]))
            _, reg_metrics = metrics_regression(reg, x_dev[[index for index, _ in dev_reg]], np.asarray([value for _, value in dev_reg]))
            state_metrics[edge].update({"posteriorMean": reg_metrics, "posteriorLabelMaskTrain": len(train_reg), "posteriorLabelMaskDevelopment": len(dev_reg)})
    report["statePosterior"] = state_metrics

    interaction_y = np.asarray([gold_by_id[row["id"]]["bundleInteraction"]["interactionValue"] for row in train], dtype=float)
    interaction_dev = np.asarray([gold_by_id[row["id"]]["bundleInteraction"]["interactionValue"] for row in development], dtype=float)
    interaction_model = fit_regressor(x_train, interaction_y)
    interaction_prediction, interaction_metrics = metrics_regression(interaction_model, x_dev, interaction_dev)
    report["bundleInteraction"] = interaction_metrics

    uplift_models = {}
    uplift_metrics = {}
    for action in ACTIONS:
        train_y = np.asarray([gold_by_id[row["id"]]["utilityGold"][action] - gold_by_id[row["id"]]["utilityGold"]["noop"] for row in train], dtype=float)
        dev_y = np.asarray([gold_by_id[row["id"]]["utilityGold"][action] - gold_by_id[row["id"]]["utilityGold"]["noop"] for row in development], dtype=float)
        model = fit_regressor(x_train, train_y)
        uplift_models[action] = model
        pred, metrics = metrics_regression(model, x_dev, dev_y)
        uplift_metrics[action] = metrics
    report["counterfactualUplift"] = uplift_metrics

    projection_status_model = fit_classifier(x_train, [gold_by_id[row["id"]]["projection"]["status"] for row in train])
    projection_decision_model = fit_classifier(x_train, [gold_by_id[row["id"]]["projection"]["decision"] for row in train])
    unit_models = {unit: fit_classifier(x_train, [int(unit in gold_by_id[row["id"]]["projection"]["selectedUnits"]) for row in train]) for unit in UNITS}
    status_pred = predict_classifier(projection_status_model, x_dev)
    decision_pred = predict_classifier(projection_decision_model, x_dev)
    unit_pred = {unit: predict_classifier(model, x_dev) for unit, model in unit_models.items()}
    projection_rows = []
    for index, row in enumerate(development):
        selected = sorted(unit for unit in UNITS if bool(unit_pred[unit][index])) if status_pred[index] == "CERTIFIED" else []
        proposal_status = "PROPOSED" if status_pred[index] == "CERTIFIED" else status_pred[index]
        projection_rows.append({"id": row["id"], "status": proposal_status, "decision": decision_pred[index], "selectedUnits": selected})
    gold_projection = [gold_by_id[row["id"]]["projection"] for row in development]
    report["decisionSufficientProjection"] = {
        "statusAccuracy": float(accuracy_score([item["status"] for item in gold_projection], status_pred)),
        "decisionAccuracy": float(accuracy_score([item["decision"] for item in gold_projection], decision_pred)),
        "selectedUnitsExactRate": float(np.mean([item["selectedUnits"] == projection_rows[i]["selectedUnits"] for i, item in enumerate(gold_projection)])),
        "privacySafeGoldRate": float(np.mean([bool(item["privacySafe"]) for item in gold_projection])),
        "predictionsPath": "projection_predictions.jsonl",
        "checkerRequired": True,
    }

    # Policy evaluation keeps the evaluator utility and incremental action cost separate.
    choices = []
    for index, row in enumerate(development):
        predicted = {action: float(uplift_models[action].predict(x_dev[index:index + 1])[0]) for action in ACTIONS}
        costs = {item["action"]: float(item["cost"]) for item in row["actionCatalog"]}
        selected = max(["noop", *ACTIONS], key=lambda action: predicted.get(action, 0.0) - (0.0 if args.ablation == "no_cost" else costs[action]))
        gold_uplift = {action: gold_by_id[row["id"]]["utilityGold"][action] - gold_by_id[row["id"]]["utilityGold"]["noop"] for action in ACTIONS}
        best = max(0.0, *gold_uplift.values())
        gold_net = {"noop": 0.0, **{action: gold_uplift[action] - costs[action] for action in ACTIONS}}
        best_net = max(gold_net.values())
        realized = 0.0 if selected == "noop" else gold_uplift[selected]
        choices.append({"id": row["id"], "selectedAction": selected, "predictedUplift": predicted, "regret": best - realized, "taskUtilityRegret": best - realized, "netUtilityRegret": best_net - gold_net[selected], "goldUplift": gold_uplift, "goldNetUtility": gold_net})
    report["policy"] = {
        "meanRegret": float(np.mean([item["regret"] for item in choices])),
        "optimalActionRate": float(np.mean([item["regret"] == 0 for item in choices])),
        "meanNetUtilityRegret": float(np.mean([item["netUtilityRegret"] for item in choices])),
        "netUtilityOptimalActionRate": float(np.mean([item["netUtilityRegret"] == 0 for item in choices])),
        "noopRate": float(np.mean([item["selectedAction"] == "noop" for item in choices])),
        "costAppliedOnceForSelection": args.ablation != "no_cost",
    }

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=False)
    (out / "metrics.json").write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    (out / "projection_predictions.jsonl").write_text("".join(json.dumps(item) + "\n" for item in projection_rows), encoding="utf-8")
    (out / "policy_predictions.jsonl").write_text("".join(json.dumps(item) + "\n" for item in choices), encoding="utf-8")
    manifest = {
        "scope": report["scope"], "evidenceLevel": report["evidenceLevel"], "publicSha256": report["publicSha256"],
        "goldSha256": report["goldSha256"], "codeSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "trainDevelopmentCalibrationOnly": True, "testRead": False, "randomSeed": args.seed,
        "hostname": socket.gethostname(), "pid": os.getpid(), "purpose": args.purpose, "ablation": args.ablation,
        "projectionCheckerRequired": True,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
