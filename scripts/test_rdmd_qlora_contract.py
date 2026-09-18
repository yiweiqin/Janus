import json
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval_rdmd_qlora import parse_completion, score_rows
from train_qlora_rdmd import assert_sft_contract


def row(status="drift", split="train", graph="g1", node="n3"):
    completion = json.dumps({
        "edgeId": "",
        "evidenceNodeIds": [node] if status == "drift" else [],
        "nodeId": node if status == "drift" else "",
        "status": status,
        "type": "wrong_version" if status == "drift" else "",
    }, sort_keys=True)
    return {
        "id": f"{graph}-{status}-{node}",
        "graph_id": graph,
        "split": split,
        "status": status,
        "supervised": True,
        "prompt": "instruction\nINPUT={\"G_star\":{\"nodes\":[{\"id\":\"n3\"}]},\"G_prime\":{}}",
        "completion": completion,
    }


class RdmdSftContractTests(unittest.TestCase):
    def test_v3_main_loss_accepts_unknown(self):
        # v3 trains abstention in the main loss; this used to be banned outright and that ban was
        # what made the v2 model answer "drift" on every single eval_unknown row.
        train = [row(), row(graph="g2", node="n4"), row(status="UNKNOWN", graph="g5")]
        development = [row(split="development", graph="g3", node="n5"), row(status="no_drift", split="development", graph="g6")]
        assert_sft_contract(train, development)

    def test_main_loss_is_driven_by_the_declared_set(self):
        train = [row(), row(status="UNKNOWN", graph="g5")]
        development = [row(split="development", graph="g3", node="n5")]
        # Same data passes when UNKNOWN is declared, fails when it is not: the contract follows the
        # dataset's manifest instead of a hardcoded trainer-side rule.
        assert_sft_contract(train, development, ("drift", "no_drift", "UNKNOWN"))
        with self.assertRaisesRegex(ValueError, "status_not_in_main_loss"):
            assert_sft_contract(train, development, ("drift", "no_drift"))

    def test_rejects_leaks_bad_status_and_bad_targets(self):
        train = [row(), row(graph="g2", node="n4")]
        development = [row(split="development", graph="g3", node="n5")]
        with self.assertRaisesRegex(ValueError, "graph_id_split_leak"):
            assert_sft_contract(train, [row(split="development", graph="g1")])
        with self.assertRaisesRegex(ValueError, "status_not_in_main_loss"):
            assert_sft_contract(train + [row(status="bogus", graph="g9")], development)
        with self.assertRaisesRegex(ValueError, "drift_missing_target"):
            bad = row()
            bad["completion"] = json.dumps({"edgeId": "", "evidenceNodeIds": [], "nodeId": "", "status": "drift", "type": ""})
            assert_sft_contract(train + [bad], development)
        with self.assertRaisesRegex(ValueError, "non_drift_has_target"):
            bad = row(status="UNKNOWN", graph="g9")
            bad["completion"] = json.dumps({"edgeId": "", "evidenceNodeIds": [], "nodeId": "n3", "status": "UNKNOWN", "type": ""})
            assert_sft_contract(train + [bad], development)

    def test_parse_and_node_hit(self):
        pred = parse_completion('```json\n{"status":"drift","nodeId":"n3","edgeId":"","type":"wrong_version","evidenceNodeIds":["n3"]}\n```')
        self.assertEqual(pred["nodeId"], "n3")
        gold = row()
        gold["prediction"] = pred
        metrics = score_rows([gold], {gold["id"]: pred})
        self.assertEqual(metrics["drift"]["nodeHit"], 1)


if __name__ == "__main__":
    unittest.main()
