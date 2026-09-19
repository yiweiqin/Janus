"""Score development Qwen outputs and export projection proposals for checking."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

EDGES = ["e0", "e1", "e2"]
ACTIONS = ["repair_e0", "repair_e1", "repair_both"]


def read(path: Path) -> list[dict]: return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
def rmse(values): return math.sqrt(sum(value * value for value in values) / len(values)) if values else None


def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("--run", required=True); parser.add_argument("--evaluation", required=True); args = parser.parse_args()
    run, evaluation = Path(args.run), Path(args.evaluation)
    gold_rows = {row["id"]: json.loads(row["completion"]) for row in read(run / "development.jsonl")}
    predictions = read(evaluation / "predictions.jsonl")
    status_correct = []; state_errors = []; interaction_errors = []; interaction_sign_correct = []; uplift_errors = []; regrets = []; net_regrets = []
    projection_status = []; projection_decision = []; projection_units = []; projection_rows = []
    valid = 0
    for row in predictions:
        gold = gold_rows[row["id"]]
        if not row["valid"]:
            regrets.append(max(0.0, *[gold["counterfactual_uplift"][action]["expected_gain"] for action in ACTIONS]))
            net_regrets.append(max(0.0, *[gold["counterfactual_uplift"][action]["expected_gain"] - gold["counterfactual_uplift"][action]["cost"] for action in ACTIONS]))
            projection_rows.append({"id": row["id"], "status": "UNKNOWN", "decision": "noop", "selectedUnits": [], "fallbackReason": row.get("reason") or "invalid_output"})
            continue
        obj = json.loads(row["output"]); valid += 1
        for edge in EDGES:
            predicted_state = obj["state_posterior"][edge]; gold_state = gold["state_posterior"][edge]
            status_correct.append(predicted_state["status"] == gold_state["status"])
            if predicted_state.get("posteriorMean") is not None and gold_state.get("posteriorMean") is not None:
                state_errors.append(float(predicted_state["posteriorMean"]) - float(gold_state["posteriorMean"]))
        predicted_interaction = float(obj["bundle_interaction"]["interactionValue"]); gold_interaction = float(gold["bundle_interaction"]["interactionValue"])
        interaction_errors.append(predicted_interaction - gold_interaction)
        interaction_sign_correct.append((predicted_interaction > 0) == (gold_interaction > 0) and (predicted_interaction < 0) == (gold_interaction < 0))
        predicted_gain = {action: float(obj["counterfactual_uplift"][action]["expected_gain"]) for action in ACTIONS}
        gold_gain = {action: float(gold["counterfactual_uplift"][action]["expected_gain"]) for action in ACTIONS}
        for action in ACTIONS: uplift_errors.append(predicted_gain[action] - gold_gain[action])
        costs = {action: float(gold["counterfactual_uplift"][action]["cost"]) for action in ACTIONS}
        selected = max(["noop", *ACTIONS], key=lambda action: predicted_gain.get(action, 0.0) - costs.get(action, 0.0))
        realized = 0.0 if selected == "noop" else gold_gain[selected]
        regrets.append(max(0.0, *gold_gain.values()) - realized)
        gold_net = {action: gold_gain[action] - costs[action] for action in ACTIONS}
        realized_net = 0.0 if selected == "noop" else gold_net[selected]
        net_regrets.append(max(0.0, *gold_net.values()) - realized_net)
        pp, gp = obj["projection_proposal"], gold["projection_proposal"]
        projection_status.append((pp["status"] == "PROPOSED") == (gp["status"] == "CERTIFIED")); projection_decision.append(pp["decision"] == gp["decision"]); projection_units.append(sorted(pp["selectedUnits"]) == sorted(gp["selectedUnits"]))
        projection_rows.append({"id": row["id"], "status": pp["status"], "decision": pp["decision"], "selectedUnits": sorted(pp["selectedUnits"])})
    metric = lambda values: float(np.mean(values)) if values else None
    schema_rate = valid / len(predictions) if predictions else 0.0
    report = {
        "scope": "synthetic_development_only_qwen_target_metrics", "evidenceLevel": "SYNTHETIC_FINITE_WORLD_ONLY",
        "rows": len(predictions), "validRows": valid, "schemaValidRate": schema_rate,
        "statePosterior": {"statusAccuracy": metric(status_correct), "conditionalMeanMae": metric([abs(v) for v in state_errors]), "conditionalMeanRmse": rmse(state_errors)},
        "bundleInteraction": {"mae": metric([abs(v) for v in interaction_errors]), "rmse": rmse(interaction_errors), "signAccuracy": metric(interaction_sign_correct)},
        "counterfactualUplift": {"mae": metric([abs(v) for v in uplift_errors]), "rmse": rmse(uplift_errors), "meanTaskUtilityRegretWithInvalidNoopFallback": metric(regrets), "meanNetUtilityRegretWithInvalidNoopFallback": metric(net_regrets), "costAppliedOnceForSelection": True},
        "projectionProposal": {"statusAccuracy": metric(projection_status), "decisionAccuracy": metric(projection_decision), "selectedUnitsExactRate": metric(projection_units), "independentCheckerRequired": True},
        "testUsed": False, "calibrationUsed": False,
    }
    (evaluation / "target_metrics.json").write_text(json.dumps(report, indent=2, allow_nan=False), encoding="utf-8")
    (evaluation / "projection_predictions.jsonl").write_text("".join(json.dumps(row) + "\n" for row in projection_rows), encoding="utf-8")
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__": main()
