"""RDMD 交付契约的测试。

最重要的一条是 `test_prompt_byte_exact_vs_trained_rows`：它拿**训练时真正喂给模型的
prompt**（`sft/*.jsonl` 里存的字符串）和本包的 `build_prompt()` 逐字节比对。

为什么非要字节级：prompt 差一个空格不会报错、模型也照样输出像样的 JSON，但分布已经
偏了，V3_FULL_REPORT 第 11 节的数字（定位 0.9993 / 弃权 1.0000）就不再适用于这个
prompt。这种降级没有任何运行时症状，只有逐字节比对能抓到。

跑法：python -m unittest discover -s experiments/rdmd_detective_dataset/deploy -v
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import rdmd_detective as rd  # noqa: E402

ROOT = HERE.parent.parent  # repo root: <repo>/Janus
DATASET = HERE.parent      # <repo>/Janus/experiments/rdmd_detective_dataset
SFT = DATASET / "sft"
DATA = DATASET / "data"

# 抽样步长：每 7 行取 1 行，跨整个 test 文件（约 252 行）。
# 为什么不是取前 N 行：截断/默认值/空白折叠这些分支只在特定长度的字段上才触发，
# 只取文件头部很容易漏掉它们。跨文件抽样能覆盖到各种字段长度与图规模。
SAMPLE_STRIDE = 7


def _read_jsonl(path: Path):
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def _drop_kind(graph: dict) -> dict:
    """复制一份图并去掉每个节点的 `kind`（其余原样）。

    用来量「丢掉选档信息会误判多少」—— 也就是把语料当 prompt 看待会付出什么代价。
    """
    return {
        **graph,
        "nodes": [{key: value for key, value in node.items() if key != "kind"}
                  for node in graph.get("nodes", [])],
    }


class InstructionMatchesJavaScript(unittest.TestCase):
    def test_instruction_is_identical_to_lib_sft_mjs(self):
        """指令一旦被人改 JS 而忘了改 Python，模型就吃着 A 的指令、以为在跑 B 的数据。

        直接从 JS 源里把数组重新解析出来，而不是在 Python 里复制一份 —— 复制品只能
        证明「两份复制品一样」，证明不了「和真正被使用的那份一样」。
        """
        source = (DATASET / "lib" / "sft.mjs").read_text(encoding="utf-8")
        block = re.search(
            r"export const DETECTIVE_INSTRUCTION = \[(.*?)\]\.join\(''\);", source, re.S
        )
        self.assertIsNotNone(block, "could not locate DETECTIVE_INSTRUCTION in lib/sft.mjs")
        js_instruction = "".join(re.findall(r"'((?:[^'\\]|\\.)*)'", block.group(1)))
        self.assertEqual(rd.DETECTIVE_INSTRUCTION, js_instruction)

    def test_drift_types_match_schema(self):
        schema = json.loads((DATASET / "schema.json").read_text(encoding="utf-8-sig"))
        self.assertEqual(list(rd.DRIFT_TYPES), list(schema["driftTypes"]))
        self.assertEqual(list(rd.STATUSES), list(schema["status"]))


class PromptIsByteExact(unittest.TestCase):
    """与训练数据里实际存下来的 prompt 比对。"""

    @classmethod
    def setUpClass(cls):
        if not (DATA / "test.jsonl").is_file() or not (SFT / "test.jsonl").is_file():
            raise unittest.SkipTest("v3 dataset not generated locally")
        cls.samples = []
        for index, row in enumerate(_read_jsonl(DATA / "test.jsonl")):
            if index % SAMPLE_STRIDE == 0:
                cls.samples.append(row)
        # 显式钉住样本量：否则一旦抽样逻辑被改坏（比如只剩 1 行），这个测试会变成
        # 「通过了但什么都没验」——比失败更危险。
        if len(cls.samples) < 200:
            raise AssertionError(
                f"byte-exact check sampled only {len(cls.samples)} rows; expected ~252. "
                "A shrunk sample set would make this test vacuous."
            )
        wanted = {row["id"] for row in cls.samples}
        cls.trained_prompts = {}
        for row in _read_jsonl(SFT / "test.jsonl"):
            if row["id"] in wanted:
                cls.trained_prompts[row["id"]] = row["prompt"]
                if len(cls.trained_prompts) == len(wanted):
                    break

    def test_prompt_byte_exact_vs_trained_rows(self):
        self.assertTrue(self.samples, "no samples loaded")
        # 每一行都必须找到对应的 SFT 行；少一行说明抽样与数据对不上，而不是「数据没有」。
        self.assertEqual(len(self.trained_prompts), len(self.samples),
                         "some sampled ids have no SFT row")
        mismatched = []
        for sample in self.samples:
            trained = self.trained_prompts.get(sample["id"])
            self.assertIsNotNone(trained, f"no sft row for {sample['id']}")
            built = rd.build_prompt(sample["G_star"], sample["G_prime"])
            if built != trained:
                # 定位到第一个不同的字符，否则报错信息对调试毫无帮助。
                offset = next(
                    (i for i, (a, b) in enumerate(zip(built, trained)) if a != b),
                    min(len(built), len(trained)),
                )
                mismatched.append(
                    f"{sample['id']}: len {len(built)} vs {len(trained)}, "
                    f"first diff @{offset}: {built[offset:offset + 40]!r} vs {trained[offset:offset + 40]!r}"
                )
        self.assertEqual(mismatched, [], "prompt drifted from the trained format:\n" + "\n".join(mismatched[:5]))

    def test_prompt_has_no_label_leak(self):
        """prompt 里不能出现 label 侧的任何东西 —— 这是 v3 防泄漏的核心，也是合规要求。

        v4 把 `"status"` **从这张黑名单里撤掉**了，因为 status 现在是合法节点字段
        （agent_step 层唯一的漂移信号），出现在 INPUT 里是设计的一部分。
        拦它的那一半职责改由「图顶层不得出现 status」这条结构化判据承担，两侧都有对应验证：
          JS —— `graphHasForbiddenKeys`（`lib/graph.mjs`，depth 0）+ `dataset.test.mjs`
                里那条 `图顶层不得出现 status…` 的用例；
          Python —— 本文件里这条用例**不**再拦节点级 status，只管 label 侧的字面量。
        所以：节点上的 status 放行，整块 label 并进图仍然会被拦。
        """
        for sample in self.samples:
            prompt = rd.build_prompt(sample["G_star"], sample["G_prime"])
            body = prompt.split("\nINPUT=", 1)[1]
            for token in ("injected_node", "injected_type", "injected_edge", "injected_form",
                          "gold", "label", "murderer"):
                self.assertNotIn(token, body, f"{sample['id']} leaked {token}")
            # 注入类型本身也不能以字面量出现在输入里（否则等于直接给答案）。
            injected_type = (sample.get("label") or {}).get("injected_type")
            if injected_type:
                self.assertNotIn(injected_type, body, f"{sample['id']} leaked type {injected_type}")


class NormalisationIsFaithful(unittest.TestCase):
    def test_text_folds_whitespace_and_truncates(self):
        self.assertEqual(rd._text("  a\n\t b   c  "), "a b c")
        self.assertEqual(rd._text(""), "")
        self.assertEqual(rd._text(None), "")
        self.assertEqual(rd._text("abcdef", 3), "abc")
        # JS 的 \s 包含 \ufeff（Python 的 \s 不含）—— 这里是刻意的差异点。
        self.assertEqual(rd._text("a\ufeffb"), "a b")

    def test_public_graph_drops_bad_nodes_and_edges_and_applies_defaults(self):
        graph = {
            "domain": "d", "title": "t", "topic": "p", "graph_id": "g1",
            "nodes": [
                {"id": "n1"},                                   # 默认值应被填上
                {"id": "", "title": "dropped"},                 # 空 id 丢弃
                {"nodeId": "n2", "title": "via nodeId"},        # id 兜底到 nodeId
                {"id": "n3", "title": "self-loop target"},
            ],
            "edges": [
                {"from": "n1", "to": "n2"},                     # id 走兜底
                {"from": "n1", "to": "n3", "id": "e13"},
                {"from": "n1", "to": "n1"},                     # 自环丢弃
                {"from": "n1", "to": "ghost"},                  # 端点不存在丢弃
            ],
            "injected_node": "n2",                              # 不该出现在公开投影里
        }
        public = rd.public_graph(graph)
        self.assertEqual([node["id"] for node in public["nodes"]], ["n1", "n2", "n3"])
        self.assertEqual(public["nodes"][0]["agentId"], "agent")
        self.assertEqual(public["nodes"][0]["version"], "v1")
        self.assertEqual(public["nodes"][0]["acceptance"], "standard")
        self.assertEqual([edge["id"] for edge in public["edges"]], ["n1->n2", "e13"])
        self.assertNotIn("graph_id", public)
        self.assertNotIn("injected_node", json.dumps(public))

    def test_node_ids_spans_both_graphs(self):
        star = {"nodes": [{"id": "n1"}]}
        prime = {"nodes": [{"id": "n2"}]}
        self.assertEqual(rd.node_ids(star, prime), {"n1", "n2"})


class ParsingAndValidation(unittest.TestCase):
    def test_parses_plain_and_fenced_json(self):
        plain = '{"status":"drift","nodeId":"n3","edgeId":"","type":"wrong_version","evidenceNodeIds":["n3"]}'
        for text in (plain, f"```json\n{plain}\n```", f"Here you go:\n{plain}\nHope that helps."):
            parsed = rd.parse_completion(text)
            self.assertFalse(parsed["parseError"], text)
            self.assertEqual(parsed["nodeId"], "n3")
            self.assertEqual(parsed["type"], "wrong_version")

    def test_parse_failure_is_abstention_not_exception(self):
        for text in ("", "I cannot tell.", "{not json", "```json\n{\n```", "[1,2,3]"):
            parsed = rd.parse_completion(text)
            self.assertTrue(parsed["parseError"], text)
            self.assertEqual(parsed["status"], "UNKNOWN")

    def test_bad_status_and_type_fall_back(self):
        parsed = rd.parse_completion('{"status":"maybe","nodeId":"n1","type":"bogus"}')
        self.assertEqual(parsed["status"], "UNKNOWN")
        # 非 drift 的答案不得携带 type / nodeId，否则下游会以为指认了凶手。
        self.assertEqual(parsed["type"], "")

    def test_unknown_may_carry_candidate_evidence(self):
        """v3 契约：UNKNOWN 的 evidenceNodeIds 是**歧义候选**，可以非空（train 里 601 行如此）。"""
        parsed = rd.parse_completion('{"status":"UNKNOWN","nodeId":"","evidenceNodeIds":["n18","n4"]}')
        self.assertEqual(parsed["status"], "UNKNOWN")
        self.assertEqual(parsed["evidenceNodeIds"], ["n18", "n4"])
        self.assertEqual(rd.validate_verdict(parsed, {"n18", "n4"}), [])

    def test_validation_catches_hallucinated_nodes(self):
        good = rd.parse_completion('{"status":"drift","nodeId":"n9","type":"wrong_agent"}')
        self.assertEqual(rd.validate_verdict(good, {"n9"}), [])
        self.assertIn("nodeId_not_in_graph:n9", rd.validate_verdict(good, {"n1"}))

        missing_type = rd.parse_completion('{"status":"drift","nodeId":"n9"}')
        self.assertIn("drift_without_type", rd.validate_verdict(missing_type, {"n9"}))

        abstained_with_culprit = rd.parse_completion('{"status":"no_drift","nodeId":"n9"}')
        self.assertIn("non_drift_has_nodeId:n9", rd.validate_verdict(abstained_with_culprit, {"n9"}))

        bad_evidence = rd.parse_completion('{"status":"UNKNOWN","evidenceNodeIds":["ghost"]}')
        self.assertIn("evidence_not_in_graph:ghost", rd.validate_verdict(bad_evidence, {"n1"}))

    def test_parse_error_is_reported_as_invalid(self):
        self.assertIn("parse_error", rd.validate_verdict(rd.parse_completion("nope"), {"n1"}))


class ExamplesAreDerivedFromRealData(unittest.TestCase):
    """`examples/` 是派生产物，手改过就不再代表真实分布 —— 这里把它钉回真实数据。"""

    def test_smoke_cases_match_the_sft_prompts(self):
        cases_path = HERE / "examples" / "smoke_cases.jsonl"
        if not cases_path.is_file() or not (SFT / "test.jsonl").is_file():
            raise unittest.SkipTest("examples or dataset not present")
        cases = list(_read_jsonl(cases_path))
        self.assertEqual(len(cases), 12)
        wanted = {case["id"] for case in cases}
        self.assertEqual(len(wanted), 12, "example ids must be unique")

        trained = {}
        for row in _read_jsonl(SFT / "test.jsonl"):
            if row["id"] in wanted:
                trained[row["id"]] = row["prompt"]
                if len(trained) == len(wanted):
                    break
        self.assertEqual(set(trained), wanted, "every example must exist in the test split")

        for case in cases:
            self.assertEqual(rd.build_prompt(case["G_star"], case["G_prime"]), trained[case["id"]],
                             f"{case['id']} example drifted from the trained prompt")

    def test_smoke_cases_carry_no_label(self):
        for case in _read_jsonl(HERE / "examples" / "smoke_cases.jsonl"):
            self.assertEqual(set(case), {"id", "G_star", "G_prime"}, "examples must be input-only")

    def test_expected_verdicts_are_schema_valid(self):
        for row in _read_jsonl(HERE / "examples" / "smoke_expected.jsonl"):
            verdict = {field: row[field] for field in rd.VERDICT_FIELDS}
            self.assertIn(verdict["status"], rd.STATUSES)
            if verdict["type"]:
                self.assertIn(verdict["type"], rd.DRIFT_TYPES)


class InputFormats(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = Path(tempfile.mkdtemp())
        self.case = {"id": "c1", "G_star": {"nodes": [{"id": "n1"}]}, "G_prime": {"nodes": [{"id": "n1"}]}}

    def _write(self, name, content):
        path = self.tmp / name
        path.write_text(content, encoding="utf-8")
        return path

    def test_single_case_json(self):
        path = self._write("one.json", json.dumps(self.case, ensure_ascii=False))
        self.assertEqual(len(rd.read_cases(path)), 1)

    def test_case_list_json(self):
        path = self._write("list.json", json.dumps([self.case, self.case], ensure_ascii=False))
        self.assertEqual(len(rd.read_cases(path)), 2)

    def test_jsonl(self):
        path = self._write("cases.jsonl", json.dumps(self.case, ensure_ascii=False) + "\n")
        self.assertEqual(len(rd.read_cases(path)), 1)

    def test_wrapped_cases_and_bom(self):
        path = self._write("wrapped.json", "\ufeff" + json.dumps({"cases": [self.case]}, ensure_ascii=False))
        self.assertEqual(len(rd.read_cases(path)), 1)

    def test_rejects_case_without_graphs(self):
        path = self._write("bad.json", json.dumps({"id": "x"}))
        with self.assertRaises(ValueError):
            rd.read_cases(path)


class BatchSurvivesPerCaseFailure(unittest.TestCase):
    """一条输入炸掉不能中断整批。

    这个入口的退出码是要驱动流水线的，所以「某条 inputs 超出上下文」必须是这条不可信，
    而不是整批消失。用真实异常类型走一遍失败记录的形状，并确认它是规范空判定。
    """

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import predict
        cls.predict = predict

    def test_failure_record_is_a_blank_verdict_marked_invalid(self):
        record = self.predict.failure_record({"id": "n7"}, ValueError("boom"))
        self.assertEqual(record["id"], "n7")
        self.assertFalse(record["valid"])
        self.assertEqual(record["raw"], "")
        self.assertEqual(record["warnings"], ["inference_error:ValueError"])
        self.assertEqual(record["verdict"]["status"], "UNKNOWN")
        for field in ("nodeId", "edgeId", "type"):
            self.assertEqual(record["verdict"][field], "")

    def test_failure_record_carries_the_exception_type_only(self):
        # 异常消息可能内含超大 prompt 片段，绝不能进记录（会把输出文件撑爆）。
        record = self.predict.failure_record({"id": "n7"}, RuntimeError("x" * 100000))
        self.assertEqual(record["warnings"], ["inference_error:RuntimeError"])
        self.assertLess(len(json.dumps(record)), 500)

    def test_missing_id_is_tolerated(self):
        record = self.predict.failure_record({}, ValueError("boom"))
        self.assertEqual(record["id"], "")


class RichGraphContract(unittest.TestCase):
    """输入契约守卫：模型要吃「富文本」节点，缺字段必须 fail-closed。

    背景（详见 V3_FULL_REPORT 第 14 节）：`public_graph` 会把缺失字段归一成空字符串，于是
    prompt 照常构建、`validate_verdict` 照常返回空警告、模型照常给一个自信的判定 —— 只是那个
    判定不再代表任何已测得的准确率。所以守卫挂在 `build_case_prompt` 这个唯一咽喉上。

    uBuddy 的任务图正是触发场景：它只有 id/title/agentId/version/acceptance/role/status。
    """

    # 与 uBuddyReverseDetective.js#normalizeDriftGraph / uBuddyTaskPublicMemory.js#normalizeTaskGraph
    # 产出的形状一致。跨模块复现脚本：experiments/rdmd_detective_dataset/ubuddy_contract_probe.mjs。
    UBUDDY_FIELDS = ("id", "title", "agentId", "version", "acceptance", "role", "status")

    @staticmethod
    def _ubuddy_case() -> dict:
        def node(node_id: str) -> dict:
            return {"id": node_id, "title": node_id, "agentId": f"agent_{node_id}",
                    "version": "v1", "acceptance": "standard", "role": node_id,
                    "status": "completed"}
        ids = ["intake", "research", "write"]
        both = {
            "nodes": [node(i) for i in ids],
            "edges": [{"id": f"{a}->{b}", "from": a, "to": b} for a, b in zip(ids, ids[1:])],
        }
        return {"id": "ubuddy", "G_star": both, "G_prime": both}

    def test_ubuddy_graph_is_rejected_before_inference(self):
        case = self._ubuddy_case()
        self.assertEqual(set(case["G_star"]["nodes"][0]), set(self.UBUDDY_FIELDS),
                         "uBuddy node shape changed; re-check the integration contract")
        problems = rd.check_case_contract(case)
        self.assertTrue(problems, "a uBuddy-shaped graph must not pass the contract")
        # v2：必需集按 kind（+ 按侧）取。这些节点没有 kind，所以回退到最严的 agent_task 一档。
        # 逐个字段按「原始数据里到底有没有」来断言，而不是断言 RICH_NODE_FIELDS 全部 —— 后者是 v1 判据。
        required = rd.required_fields_for_kind(rd.CONTRACT_FALLBACK_KIND, "exec")
        self.assertEqual(set(required), {"title", "summary", "output"})
        present = {key for node in case["G_star"]["nodes"] for key, value in node.items() if value}
        for field in required:
            reported = any(problem.endswith(f"empty_{field}") for problem in problems)
            # uBuddy 节点有 title（它是有来源的字段），所以 title 不该被报；
            # summary/output 没有，必须被报。两边都断言，才算真的验了分档。
            self.assertEqual(reported, field not in present,
                             f"{field}: reported={reported} but present={field in present}")
        # 没有来源的字段**不再**被要求（v2 唯一的放宽方向）。这些字段一个都不该出现，
        # 否则说明必需集又退回了「语料判据」，真实数据会永远过不了。
        for field in ("artifact", "stage", "inputs"):
            self.assertFalse(any(problem.endswith(f"empty_{field}") for problem in problems),
                             f"{field} 没有真实来源，不该再被要求")
        # 咽喉处必须抛，而不是悄悄拼出一个空字段的 prompt。
        with self.assertRaises(rd.InputContractError):
            rd.build_case_prompt(case)

    def test_an_empty_field_on_one_node_is_enough(self):
        """判据是逐节点的，不是全图统计：一个节点缺字段就已经出了训练支持集。"""
        def node(node_id: str, output: str) -> dict:
            return {"id": node_id, "title": node_id, "summary": "有", "output": output}

        # outcome 文本只在执行侧有来源，所以缺口报在 G_prime 上（见准入规则 (c)）。
        star = {"nodes": [node("n1", "有"), node("n2", "有")], "edges": []}
        prime = {"nodes": [node("n1", "有"), node("n2", "")], "edges": []}
        problems = rd.check_case_contract({"G_star": star, "G_prime": prime})
        self.assertEqual(problems, ["G_prime:n2:empty_output"])
        # 规划侧同一处空 output **不该**被报：那一侧本来就写不出它。
        self.assertEqual(rd.check_case_contract({"G_star": prime, "G_prime": star}), [])

    def test_outcome_text_is_required_only_on_the_exec_side(self):
        """准入规则 (c)：规划侧写不出的字段不进规划侧的必需集。

        这一条是「真实群任务能不能过闸门」的分水岭：规划图的两个来源
        （`proposalNodesFromTaskRun` 与首版 plan step）都不带 outcome 文本，
        所以在规划侧要求 summary/output 会让**每一个**真实群任务恒 fail-closed。
        """
        # 规划侧的真实形状：提案节点只有 title/agentId。
        plan = {"nodes": [{"id": "n1", "title": "缺失值处理", "agentId": "data_agent_5",
                           "kind": "agent_task"}], "edges": []}
        # 执行侧同名节点有 outcome 文本。
        exec_full = {"nodes": [{"id": "n1", "title": "缺失值处理", "agentId": "data_agent_5",
                                "summary": "对字段做了缺失值处理", "output": "产出 12 列宽表",
                                "kind": "agent_task"}], "edges": []}
        self.assertEqual(rd.check_case_contract({"G_star": plan, "G_prime": exec_full}), [],
                         "规划侧缺 outcome 文本必须放过，否则真实群任务永远过不了闸门")
        self.assertEqual(rd.required_fields_for_kind("agent_task", "plan"), ("title",))
        self.assertEqual(set(rd.required_fields_for_kind("agent_task", "exec")),
                         {"title", "summary", "output"})
        # 放宽只发生在规划侧：执行侧缺 output 仍然必须报。
        exec_missing = {"nodes": [{"id": "n1", "title": "缺失值处理", "summary": "有",
                                   "output": "", "kind": "agent_task"}], "edges": []}
        self.assertEqual(rd.check_case_contract({"G_star": plan, "G_prime": exec_missing}),
                         ["G_prime:n1:empty_output"])
        # 而且规划侧不是「什么都不判」：title 仍然要判。
        plan_bare = {"nodes": [{"id": "n1", "title": "", "kind": "agent_task"}], "edges": []}
        self.assertEqual(rd.check_case_contract({"G_star": plan_bare, "G_prime": exec_full}),
                         ["G_star:n1:empty_title"])

    def test_only_fields_with_an_independent_source_are_required(self):
        """准入规则的自检：必需集里的每个字段都必须对该层有独立来源。

        规则写死在注释里没有用，得有东西拦着。谁把 artifact 加进 agent_task 的必需集，
        或者把 step 的 agentId（继承自父节点）当成独立信号，这里立刻失败。
        """
        # 与 uBuddyPlanExec.js#PLAN_EXEC_FIELD_SOURCES / PLAN_EXEC_INHERITED_FIELDS_BY_KIND 同一张表。
        # 判的是**声明**必需集（不是生效集）：准入规则 (a) 是「有没有来源」，
        # 与「模型此刻能不能看见」无关。P2 之前 status 尚未可见，但它有真实来源，
        # 所以它该在声明表里 —— 这里正好把这两件事分开验。
        no_source = {"role", "artifact", "stage", "inputs"}       # missing
        constant = {"version", "acceptance"}                       # constant
        for side in rd.SIDES:
            for kind, fields in rd.DECLARED_REQUIRED_FIELDS_BY_KIND.items():
                for field in fields:
                    self.assertNotIn(field, no_source, f"{kind}.{field} 没有来源")
                    self.assertNotIn(field, constant, f"{kind}.{field} 只是常量")
                    self.assertNotIn(field, rd.INHERITED_FIELDS_BY_KIND.get(kind, ()),
                                     f"{kind}.{field} 是继承自父节点的，不是独立信号")
                    # (c)：规划侧写不出的字段必须已经在声明集里被剔掉。
                    if not rd.field_exists_on_side(field, side):
                        self.assertNotIn(field, rd.declared_required_fields_for_kind(kind, side),
                                         f"{side}/{kind}.{field} 该侧写不出来，不该留在声明集里")
        # inherited 这一类必须真实存在于表里，否则这个自检会在空集上空转。
        self.assertIn("agentId", rd.INHERITED_FIELDS_BY_KIND["agent_step"])
        # (c) 这张表本身也要可复核：规划侧只能缺 outcome 文本，不能顺手把 title 也放掉。
        for side in rd.SIDES:
            self.assertIn("title", rd.required_fields_for_kind("agent_task", side))
            self.assertIn("title", rd.required_fields_for_kind("agent_step", side))
        self.assertNotIn("output", rd.declared_required_fields_for_kind("agent_task", "plan"))
        self.assertIn("output", rd.declared_required_fields_for_kind("agent_task", "exec"))

    def test_step_tier_requires_status_only_once_it_is_prompt_visible(self):
        """step 一档的必需集由 `status` 的可见性**推导**出来，不是写死的。

        两种情况都必须是「对」的，而且只有一条分界线：
        - `status` 还没进 `NODE_FIELDS`（P1 的现状）：契约**不得**要求它。要求一个模型
          读不到的字段，只会把合法输入判死，还会让 JS/Python 两侧在「到底该不该报」上分叉。
          此时 `deferred_required_fields()` 必须把它报出来，否则一个忘记同步 prompt 的人
          会以为 step 层已经在判 status 了。
        - `status` 进了 `NODE_FIELDS`（P2 之后）：同一份输入必须立刻被报成缺字段，
          **一处改动两侧同时生效**。P2 已经把这一步落地了（`NODE_FIELDS` 现在含 status、
          `deferred_required_fields()` 为空），但这个用例仍然按**推导**判，而不是写死今天的行为 ——
          将来谁把 status 从 `NODE_FIELDS` 里拿掉，它会立刻在另一半分支上失败。

        所以这个用例不是「钉住今天的行为」，而是钉住「行为随可见性正确迁移」。
        """
        step = {"id": "s", "G_star": {"nodes": [{"id": "s1", "title": "第 1 步",
                                                 "kind": "agent_step", "status": "completed"}], "edges": []}}
        step["G_prime"] = step["G_star"]
        # 把 status 清空，其它字段保持非空。
        for name in ("G_star", "G_prime"):
            step[name]["nodes"][0]["status"] = ""

        problems = rd.check_case_contract(step)
        status_visible = "status" in rd.NODE_FIELDS
        deferred = rd.deferred_required_fields()
        if status_visible:
            self.assertEqual(problems, ["G_star:s1:empty_status", "G_prime:s1:empty_status"])
            self.assertNotIn("plan/agent_step", deferred, "status 已可见，就不该再报成「延后生效」")
            self.assertNotIn("exec/agent_step", deferred)
        else:
            self.assertEqual(problems, [], "status 不可见时不能要求它，否则合法输入会被判死")
            # 刻意延后必须可见，否则没人知道 step 层还没真正打开。两侧都要报。
            self.assertEqual(deferred.get("plan/agent_step"), ["status"])
            self.assertEqual(deferred.get("exec/agent_step"), ["status"])

        # 两种情况下 title 都在判，所以 step 一档不是空转。
        self.assertIn("title", rd.required_fields_for_kind("agent_step"))
        # 先把 status 放回非空，再单独清 title。两个字段同时缺的话报出来的问题分不清是哪一条，
        # 断言会变成"总数对了就行"，那就测不出 title 有没有真的在判。
        for name in ("G_star", "G_prime"):
            step[name]["nodes"][0]["status"] = "completed"
            step[name]["nodes"][0]["title"] = ""
        self.assertEqual(rd.check_case_contract(step),
                         ["G_star:s1:empty_title", "G_prime:s1:empty_title"])

    def test_kind_is_read_from_the_raw_case_not_the_projection(self):
        """kind 是选档用的选择器，**不进** prompt，所以只能从原始 case 取。

        从投影后的图里是拿不到它的；这条用例把这个事实钉住，免得有人「顺手」把 kind
        加进 public_graph —— 那会改变 prompt 形状，v3 的权重立刻不可用。
        """
        raw = {"nodes": [{"id": "a", "title": "A", "kind": "agent_step"},
                         {"id": "b", "title": "B", "kind": "agent_task"},
                         {"id": "c", "title": "C"}], "edges": []}
        self.assertEqual(rd.node_kind_lookup(raw),
                         {"a": "agent_step", "b": "agent_task", "c": rd.CONTRACT_FALLBACK_KIND})
        self.assertNotIn("kind", rd.public_graph(raw)["nodes"][0])

    @staticmethod
    def _graphs_from_prompt(prompt: str) -> tuple[dict, dict]:
        """SFT 行存的是 prompt 字符串（不是 G_star/G_prime），所以把输入还原出来。

        这样测的是**模型当时真正吃进去的那份输入**，而不是另一个来源的副本 —— 后者只能证明
        两份副本一样。

        注意：这份还原结果**不能**用来判契约 —— prompt 刻意不含 `kind`，而 v4 的必需集按
        `kind` 选档（见 `test_the_contract_needs_the_raw_kind_because_the_prompt_hides_it`）。
        判契约必须用带 kind 的原始 case（`data/*.jsonl`）。
        """
        payload = json.loads(prompt.split("INPUT=", 1)[1])
        return payload["G_star"], payload["G_prime"]

    def test_legal_corpus_rows_are_never_rejected(self):
        """守卫如果会误伤合法输入，比没有守卫更糟。在五个真实盘上量一遍。

        判据（v2 起按 kind 分档）就是从这批数据量出来的：v3 时代是「11 字段全非空」在
        10,332 张图 / 207,356 个节点实例上 0 例外；v4 换成按 kind 的必需集之后，这条用例
        的职责变成「**语料里每一个真实节点实例**都满足它自己那一档的要求」。它同时防止
        两件事：后续把判据改严到误伤真数据，以及判据被改成空转。

        **为什么必须读 `data/` 而不是从 prompt 还原**：v4 的必需集按 `kind` 选档，而
        `kind` 是刻意**不进 prompt** 的（它只给分层加权用，进 prompt 就成了「按第几层作弊」）。
        从 prompt 还原出来的图里每个节点都会回退到最严的 `agent_task` 一档，于是
        step 节点（产品上富文本恒空）会被全部误判成缺字段 —— 那不是守卫有问题，
        是这份输入本来就丢掉了选档信息。真实推理路径上 `check_case_contract` 拿到的是
        带 kind 的原始 case（见 `predict.py` 的入参契约），所以这里也必须用同一份来源。
        prompt 的逐字节正确性由 `PromptIsByteExact` 覆盖，两件事分开测。
        """
        sampled = 0
        per_split = {}
        for name in ("train", "development", "test", "ood_cases", "adv_cases"):
            path = DATA / f"{name}.jsonl"
            if not path.is_file():
                continue
            count = 0
            for index, row in enumerate(_read_jsonl(path)):
                if index % SAMPLE_STRIDE:
                    continue
                problems = rd.check_case_contract({"G_star": row["G_star"], "G_prime": row["G_prime"]})
                self.assertEqual(problems, [], f"{name}:{row['id']} was wrongly rejected")
                count += 1
            if count:
                per_split[name] = count
                sampled += count
        # 否则抽样一旦被改坏，这个测试会「通过但什么都没验」。
        self.assertGreaterEqual(sampled, 1000,
                                f"only {sampled} rows checked; a shrunk sample makes this vacuous")
        self.assertGreaterEqual(len(per_split), 3, f"too few splits covered: {per_split}")

    def test_the_contract_needs_the_raw_kind_because_the_prompt_hides_it(self):
        """反向钉住上一条的前提：丢掉 kind 之后，同一批合法数据**确实**会被误判。

        这不是抱怨，是记录一条真实约束 —— 谁要是以后把 `check_case_contract` 接到
        prompt 还原出来的图上（比如为了省一次投影），这个用例会立刻红，而不是等到
        线上所有群任务恒判 `input_contract_violation` 才发现。
        """
        step_rows = 0
        rejected = 0
        for index, row in enumerate(_read_jsonl(DATA / "train.jsonl")):
            if index % SAMPLE_STRIDE:
                continue
            if not any(node.get("kind") == "agent_step" for node in row["G_star"]["nodes"]):
                continue
            step_rows += 1
            problems = rd.check_case_contract({
                "G_star": _drop_kind(row["G_star"]),
                "G_prime": _drop_kind(row["G_prime"]),
            })
            if problems:
                rejected += 1
        self.assertGreater(step_rows, 50, f"only {step_rows} step-bearing rows sampled")
        self.assertGreater(rejected, 0,
                           "丢掉 kind 之后一个都不误判，说明这条约束已经失效，可以撤掉")

    def test_problem_summary_is_capped(self):
        """一根 20 节点图缺字段会产生上百条问题；记录里只能放摘要，否则输出文件会被撑爆。"""
        ids = [f"n{i}" for i in range(20)]
        graph = {"nodes": [{"id": n} for n in ids], "edges": []}
        problems = rd.check_case_contract({"G_star": graph, "G_prime": graph})
        # 条数由必需集决定，所以从表里算，别写死 —— 写死会让这个用例在契约改动时
        # 以一种看不出原因的方式失败。
        expected = len(ids) * sum(len(rd.required_fields_for_kind(rd.CONTRACT_FALLBACK_KIND, side))
                                  for side in rd.SIDES)
        self.assertEqual(len(problems), expected)
        summary = rd.summarize_contract_problems(problems)
        self.assertIn(f"+{expected - 3} more", summary)
        self.assertLess(len(summary), 300)

    def test_contract_record_is_a_blank_verdict_marked_invalid(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import predict
        case = self._ubuddy_case()
        record = predict.contract_record(case, rd.check_case_contract(case))
        self.assertEqual(record["id"], "ubuddy")
        self.assertFalse(record["valid"])
        self.assertEqual(record["raw"], "")
        self.assertTrue(record["warnings"][0].startswith("input_contract_violation:"))
        self.assertEqual(record["verdict"]["status"], "UNKNOWN")
        for field in ("nodeId", "edgeId", "type"):
            self.assertEqual(record["verdict"][field], "")


class ContractParityWithJs(unittest.TestCase):
    """JS 与 Python 两份契约实现必须逐条一致。

    契约有两份实现（`src/shared/contracts/uBuddyPlanExec.js#planExecContractGaps` 与
    `rdmd_detective.py#check_case_contract`）。两份各自单测都能过，却可能在
    「kind 缺失怎么回退」「哪些字段要判」上悄悄分叉 —— 分叉的后果是 JS 认为这条 case
    可以推理、Python 认为不行（或反过来），fail-closed 静默失效，没有任何运行时症状。

    这里让 JS 侧**现算**一遍（而不是读一份可能过期的产物）：产物会被遗忘，
    而遗忘正是这类分叉唯一的藏身处。
    """

    SCRIPT = HERE / "_contract_parity_fixtures.mjs"

    @classmethod
    def setUpClass(cls):
        if not cls.SCRIPT.is_file():
            raise unittest.SkipTest("js parity fixture script missing")
        try:
            proc = subprocess.run(
                ["node", str(cls.SCRIPT)],
                capture_output=True, text=True, encoding="utf-8", cwd=str(HERE), check=False,
            )
        except FileNotFoundError:
            raise unittest.SkipTest("node not available")
        if proc.returncode != 0:
            raise AssertionError(f"node parity script failed: {(proc.stderr or '')[:2000]}")
        cls.payload = json.loads(proc.stdout)

    def test_python_and_js_agree_case_by_case(self):
        fixtures = self.payload["fixtures"]
        js_verdicts = self.payload["verdicts"]
        self.assertGreaterEqual(len(fixtures), 10, "fixture 集变小了，逐条比对会变成空转")
        for fixture in fixtures:
            case = {"id": fixture["name"], "G_star": fixture["G_star"], "G_prime": fixture["G_prime"]}
            self.assertEqual(
                rd.check_case_contract(case), js_verdicts[fixture["name"]],
                f"{fixture['name']}: 两侧判定分叉（{fixture['note']}）",
            )

    def test_the_fixture_set_actually_exercises_both_outcomes(self):
        """若两侧都判「全部通过」，逐条相等就没有信息量。"""
        verdicts = self.payload["verdicts"]
        failing = sorted(name for name, problems in verdicts.items() if problems)
        passing = sorted(name for name, problems in verdicts.items() if not problems)
        self.assertGreaterEqual(len(failing), 4, f"会失败的 fixture 太少: {failing}")
        self.assertGreaterEqual(len(passing), 3, f"会通过的 fixture 太少: {passing}")
        # 每一档都必须被覆盖到，否则「按 kind 分档」这件事其实没验。
        self.assertIn("agent_step_missing_title", failing)
        self.assertIn("agent_task_missing_each_required_field", failing)
        self.assertIn("unknown_kind_falls_back", failing)
        self.assertIn("no_source_fields_are_not_required", passing)
        self.assertIn("root_and_ubuddy_only_need_title", failing, "root 缺 title 必须报")
        self.assertIn("agent_step_complete", passing, "字段齐全的 step 不能因为分档被误报")

        # (c)「哪一侧写得出来」必须**两个方向**都被验到：
        # 规划侧缺 outcome 要放过（否则真实群任务恒 fail-closed），
        # 执行侧缺 outcome 仍要报（否则放宽就漏到了归因主战场）。
        self.assertIn("plan_side_does_not_require_outcome_text", passing,
                      "规划侧不该要求它写不出的 outcome 文本")
        self.assertIn("exec_side_still_requires_outcome_text", failing,
                      "执行侧缺 outcome 必须仍然报")
        self.assertIn("plan_side_missing_title_still_fails", failing,
                      "(c) 只能剔掉 outcome 文本，不能把 title 也放掉")
        self.assertIn("empty_plan_graph_is_reported_on_the_plan_side", failing,
                      "规划图为空必须报在 G_star 上")

        # `agent_step_missing_status` 的归属**随可见性迁移**，不写死：
        # status 不可见时它必须通过（契约不许要求模型读不到的字段），可见时它必须失败
        # （否则 step 档就白开了）。这样 P2 同步 prompt 时它自动换桶，而不是需要人去改断言 ——
        # 需要人改的那种断言，恰恰是会在两个方向上都静默失效的。
        bucket = failing if "status" in rd.NODE_FIELDS else passing
        self.assertIn("agent_step_missing_status", bucket,
                      f"status 可见={('status' in rd.NODE_FIELDS)}，该 fixture 应在 {bucket}")


if __name__ == "__main__":
    unittest.main()
