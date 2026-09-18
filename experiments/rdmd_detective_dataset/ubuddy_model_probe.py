"""What does the shipped model entry point do with a uBuddy-shaped graph?

Run: python experiments/rdmd_detective_dataset/ubuddy_model_probe.py
     python experiments/rdmd_detective_dataset/ubuddy_model_probe.py --emit data/ubuddy_shaped_cases.jsonl

"Fails loudly" and "silently answers from empty fields" are very different risks for integration.
This runs the delivered contract module only (no GPU): build_prompt + parse/validate on a graph that
has the 6 fields uBuddy actually produces. Companion to `ubuddy_contract_probe.mjs`.

`--emit` writes a fixture in the real uBuddy node shape, so the fail-closed behaviour can be
reproduced end-to-end through the CLI:

    python deploy/predict.py --input data/ubuddy_shaped_cases.jsonl --dry-run   # -> exit 1
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEPLOY = HERE / "deploy"
sys.path.insert(0, str(DEPLOY))
import rdmd_detective as rd  # noqa: E402

# Exactly the keys normalizeTaskGraph (uBuddyTaskPublicMemory.js) / normalizeDriftGraph
# (uBuddyReverseDriftDetective.js) produce for a live task graph.
UBUDDY_NODE_FIELDS = ("id", "title", "agentId", "version", "acceptance", "role", "status")


def ubuddy_graph(agent: str) -> dict:
    def node(node_id: str) -> dict:
        return {
            "id": node_id, "title": node_id, "agentId": agent, "version": "v1",
            "acceptance": "standard", "role": node_id, "status": "completed",
        }
    ids = ["intake", "research", "write"]
    return {
        "nodes": [node(i) for i in ids],
        "edges": [{"id": f"{a}->{b}", "from": a, "to": b}
                  for a, b in zip(ids, ids[1:])],
    }


def ubuddy_cases() -> list[dict]:
    """A realistic pair: one wrong_agent drift, one identical (no_drift)."""
    def swapped() -> dict:
        graph = ubuddy_graph("agent_a")
        graph["nodes"][1]["agentId"] = "agent_other"
        return graph

    return [
        {"id": "ubuddy_wrong_agent", "G_star": ubuddy_graph("agent_a"), "G_prime": swapped()},
        {"id": "ubuddy_no_drift", "G_star": ubuddy_graph("agent_a"), "G_prime": ubuddy_graph("agent_a")},
    ]


def emit(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(case, ensure_ascii=False) for case in ubuddy_cases()) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {len(ubuddy_cases())} cases -> {path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--emit", default="", help="write the uBuddy-shaped fixture and exit")
    args = parser.parse_args()
    if args.emit:
        return emit(Path(args.emit))

    case = ubuddy_cases()[0]
    print("=== input contract check (this is the guard that must fire) ===")
    problems = rd.check_case_contract(case)
    print("problems:", rd.summarize_contract_problems(problems))
    print("raises on prompt build:", end=" ")
    try:
        rd.build_case_prompt(case)
    except rd.InputContractError as exc:
        print(f"YES ({exc})")
    else:
        print("NO -- fail-open, which is the bug this guard exists to prevent")

    print("\n=== what the model WOULD have seen if there were no guard ===")
    prompt = rd.build_prompt(case["G_star"], case["G_prime"])
    payload = json.loads(prompt.split("INPUT=")[1])
    print("node:", json.dumps(payload["G_star"]["nodes"][1], ensure_ascii=False))
    print("prompt chars:", len(prompt), "(training range was 11221-13016)")

    print("\n=== validate_verdict is NOT a substitute for the guard ===")
    verdict = rd.parse_completion(json.dumps({
        "status": "drift", "nodeId": "research", "edgeId": "",
        "type": "wrong_agent", "evidenceNodeIds": ["research"],
    }, ensure_ascii=False))
    print("validate_verdict:", rd.validate_verdict(verdict, {"intake", "research", "write"}))
    print("=> empty warnings: it only checks that nodeId exists, never that the input was rich.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
