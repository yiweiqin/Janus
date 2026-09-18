"""GPU worker 的判定归一测试（无 GPU、无网络、无 torch）。

为什么需要这个文件：`verdict_from_record` 是 P4 链路上**唯一**把「模型输出」翻译成
「云侧判定契约」的地方，而它的失败模式是静默的 —— 真机 E2E 上模型回了
`{"status":"drift","nodeId":"n_step","type":""}`，worker 原样回传，云侧 400
`rdmd_verdict_incomplete`，作业于是既结不掉也领不到。这条 bug 在两侧的单测里都看不见
（云侧测的是"非法形状要被拒"，Python 侧测的是"模型输出要能被解析"），
所以这里专门测**两侧之间的那个翻译**。

断言的核心是一条不变量，而不是几个样例：
    只要 verdict_from_record 的产物有 status == 'drift'，它的 nodeId 与 type 就必须都非空。
因为云侧 `normalizeVerdict` 只认这一种 drift，违反它就等于把一个语义问题变成一次 HTTP 400。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from rdmd_gpu_worker import verdict_from_record  # noqa: E402


def record(status="drift", node="n_step", type_name="missing_dependency", *, valid=True,
           warnings=None, raw="") -> dict:
    """按 predict.py 的真实记录形状造一条（键为 id/verdict/raw/valid/warnings）。"""
    return {
        "id": "case-1",
        "verdict": {
            "status": status,
            "nodeId": node,
            "edgeId": "",
            "type": type_name,
            "evidenceNodeIds": [node] if node else [],
        },
        "raw": raw,
        "valid": valid,
        "warnings": list(warnings or []),
    }


def assert_drift_is_well_formed(test: unittest.TestCase, verdict: dict) -> None:
    """云侧 normalizeVerdict 的 drift 形状要求，在这里复述一遍当不变量。"""
    if verdict["status"] == "drift":
        test.assertTrue(verdict["nodeId"], "云侧要求 drift 必须带 nodeId")
        test.assertTrue(verdict["type"], "云侧要求 drift 必须带 type（否则 400 rdmd_verdict_incomplete）")


class WorkerVerdictTests(unittest.TestCase):
    def test_valid_drift_passes_through(self):
        verdict = verdict_from_record(record())
        self.assertEqual(verdict["status"], "drift")
        self.assertEqual(verdict["nodeId"], "n_step")
        self.assertEqual(verdict["type"], "missing_dependency")
        self.assertTrue(verdict["valid"])
        self.assertEqual(verdict["reason"], "")
        assert_drift_is_well_formed(self, verdict)

    def test_valid_no_drift_abstains(self):
        verdict = verdict_from_record(record(status="no_drift", node="", type_name=""))
        self.assertEqual(verdict["status"], "no_drift")
        self.assertEqual(verdict["nodeId"], "")
        self.assertEqual(verdict["type"], "")
        self.assertTrue(verdict["valid"])

    def test_valid_unknown_carries_a_reason(self):
        # 模型主动弃权要有 reason，否则线上分不清"它说不清"和"它没答"。
        verdict = verdict_from_record(record(status="UNKNOWN", node="", type_name=""))
        self.assertEqual(verdict["status"], "UNKNOWN")
        self.assertEqual(verdict["reason"], "model_unknown")
        self.assertTrue(verdict["valid"])

    def test_drift_without_type_is_downgraded_to_abstention(self):
        """真机 E2E 上撞到的那一条：节点指对了，说不出类型。"""
        live = record(
            node="n_step", type_name="", valid=False, warnings=["drift_without_type"],
            raw='{"edgeId":"e2","evidenceNodeIds":["n_step"],"nodeId":"n_step","status":"drift","type":""}',
        )
        verdict = verdict_from_record(live)

        self.assertEqual(verdict["status"], "UNKNOWN", "说不出来就该弃权，而不是发一条云侧必拒的 drift")
        self.assertEqual(verdict["nodeId"], "", "UNKNOWN 必须完全弃权：两侧对它的定义都是不许指认凶手")
        self.assertEqual(verdict["type"], "")
        self.assertFalse(verdict["valid"])
        self.assertEqual(verdict["reason"], "drift_without_type")
        # 但它当时指向哪里不能丢：审计要能回答"模型认为问题在哪个节点"。
        self.assertIn("unusable_claim:n_step/-", verdict["warnings"])
        assert_drift_is_well_formed(self, verdict)

    def test_drift_without_node_id_is_downgraded(self):
        verdict = verdict_from_record(record(node="", valid=False, warnings=["drift_without_nodeId"]))
        self.assertEqual(verdict["status"], "UNKNOWN")
        self.assertEqual(verdict["reason"], "drift_without_nodeId")
        assert_drift_is_well_formed(self, verdict)

    def test_node_id_not_in_graph_is_downgraded(self):
        # 编出一个图里不存在的 nodeId 是模型确实会犯的错（validate_verdict 的存在理由）。
        verdict = verdict_from_record(record(node="n_ghost", valid=False, warnings=["nodeId_not_in_graph:n_ghost"]))
        self.assertEqual(verdict["status"], "UNKNOWN")
        self.assertEqual(verdict["reason"], "nodeId_not_in_graph:n_ghost")
        self.assertIn("unusable_claim:n_ghost/missing_dependency", verdict["warnings"])

    def test_parse_error_is_downgraded_and_never_claims_a_drift(self):
        verdict = verdict_from_record(record(status="UNKNOWN", node="", type_name="", valid=False,
                                             warnings=["parse_error"]))
        self.assertEqual(verdict["status"], "UNKNOWN")
        self.assertEqual(verdict["reason"], "parse_error")
        assert_drift_is_well_formed(self, verdict)

    def test_contract_violation_keeps_its_actionable_reason(self):
        # 输入契约违规的修法是"去补字段"，reason 必须原样透传，不能被降级成笼统的 invalid_verdict。
        verdict = verdict_from_record(record(status="UNKNOWN", node="", type_name="", valid=False,
                                             warnings=["input_contract_violation:agent_task:missing output"]))
        self.assertEqual(verdict["reason"], "input_contract_violation:agent_task:missing output")

    def test_invalid_without_warnings_still_gets_a_reason(self):
        verdict = verdict_from_record(record(valid=False, warnings=[]))
        self.assertEqual(verdict["reason"], "invalid_verdict")

    def test_unknown_status_from_model_becomes_abstention(self):
        # parse_completion 已经归一过，这里是第二道保险：未知 status 不许透传到云侧（会被 400）。
        verdict = verdict_from_record(record(status="drifted", node="n1", type_name="wrong_agent", valid=False))
        self.assertIn(verdict["status"], ("UNKNOWN", "no_drift", "drift"))
        assert_drift_is_well_formed(self, verdict)

    def test_every_invalid_record_yields_a_cloud_acceptable_drift_shape(self):
        """穷举 invalid 的常见组合，确认没有一条能穿透成"会被 400 拒的 drift"。"""
        cases = [
            record(node="", type_name="", valid=False, warnings=["drift_without_nodeId", "drift_without_type"]),
            record(node="n1", type_name="not_a_real_type", valid=False, warnings=["drift_without_type"]),
            record(node="n2", type_name="wrong_agent", valid=False, warnings=["evidence_not_in_graph:n9"]),
            record(node="n1", type_name="wrong_version", valid=False, warnings=["random_warning"]),
        ]
        for index, case in enumerate(cases):
            with self.subTest(case=index):
                assert_drift_is_well_formed(self, verdict_from_record(case))

    def test_warnings_are_capped(self):
        # warnings 会随判定落库并回传，不能让一条记录把它撑爆。
        verdict = verdict_from_record(record(valid=False, warnings=[f"w{index}" for index in range(50)]))
        self.assertLessEqual(len(verdict["warnings"]), 20)


if __name__ == "__main__":
    unittest.main()
