"""RDMD 反向侦探：推理契约（单一事实来源）。

这个模块把三件事固化下来，任何调用方都必须走它，不要自己拼：

1. `build_prompt()` —— prompt 的形状。**这是模型见过的那一份**，逐字节对齐
   `experiments/rdmd_detective_dataset/lib/sft.mjs` 的 `promptOf()`。自己拼 prompt 不会
   报错、模型也照样会说人话，但准确率不再代表 V3_FULL_REPORT 第 11 节的数字 ——
   这是最隐蔽的一种降级，所以 `test_rdmd_detective.py` 会拿真实 SFT 行做逐字节比对。
2. `parse_completion()` —— 模型输出的容错解析（可能带 markdown 围栏、解释性文字）。
3. `validate_verdict()` —— 语义校验：nodeId / evidenceNodeIds 必须真的出现在图里。

模型：Qwen3-8B + LoRA adapter（`rdmd_detective_sft_v3` 数据训练，1060 步 / 2 epoch）。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

# ---------------------------------------------------------------------------
# 契约常量
# ---------------------------------------------------------------------------

# 与 lib/sft.mjs#DETECTIVE_INSTRUCTION 逐字节一致（单测会从 JS 源里重新解析并比对）。
DETECTIVE_INSTRUCTION = (
    "你是反向侦探。输入是规划树 G_star 和执行树 G_prime。"
    "多数可见差异是后果。找出引起差异的最小漂移节点，不要把末端差异当成原因。"
    "只返回一个 JSON 对象，不要解释，不要 markdown。"
    "字段：status, nodeId, edgeId, type, evidenceNodeIds。"
    "status 只能是 drift、no_drift 或 UNKNOWN。"
    "type 只能是 missing_dependency、wrong_agent、wrong_version、wrong_acceptance、local_replan，或空字符串。"
    "两树相同时 status=no_drift，其余字段为空。"
    "存在多个不相交原因或证据不足时 status=UNKNOWN，不要编造唯一凶手。"
    "nodeId 必须是图中出现过的节点，evidenceNodeIds 只放定位证据，不要罗列全部变点。"
)

STATUSES = ("drift", "no_drift", "UNKNOWN")
DRIFT_TYPES = (
    "missing_dependency",
    "wrong_agent",
    "wrong_version",
    "wrong_acceptance",
    "local_replan",
)
VERDICT_FIELDS = ("status", "nodeId", "edgeId", "type", "evidenceNodeIds")

# 这份 Python 实现所遵循的**输入契约版本**。必须与 JS 侧
# `src/shared/contracts/uBuddyPlanExec.js#PLAN_EXEC_CONTRACT_VERSION` 逐字一致
# （两侧契约互测会覆盖规则，这个名字是给**云侧出处**用的）。
#
# 为什么 Python 也需要这个名字：GPU worker 回传判定时要带上"我是按哪一版契约判的"。
# 云侧在领活响应里给出它认可的版本，worker 拿这个常量去比对，不一致就**不产出判定**。
# 少了这一条，出处就变成了由被审计方自己填写的字段 —— 那正是"不可审计的判定
# 等于没有判定"要防的事。
CONTRACT_VERSION = "ubuddy_plan_exec_v2"

# publicGraph 暴露给模型的节点/边字段。注意 prompt 里**不含** label 侧的任何东西
# （injected_node / injected_type / ... ），这是 v3 防泄漏的核心。
NODE_FIELDS = (
    "id", "title", "role", "agentId", "version", "acceptance",
    "artifact", "stage", "inputs", "output", "summary",
    # P2：执行状态。加进这里（而不是只加进 prompt）是刻意的 ——
    # `required_fields_for_kind` 只从 NODE_FIELDS 里取值，所以这一步同时把
    # agent_step 一档从「只判 title」收紧成「title + status」，并且让
    # `deferred_required_fields()` 里的 step 条目清空。
    # 必须与 src/shared/contracts/uBuddyPlanExec.js#PLAN_EXEC_NODE_FIELDS 逐字一致。
    "status",
)
EDGE_FIELDS = ("id", "from", "to")

# 「富文本」字段：模型相对规则基线的**全部**优势都来自它们（第 12.4 节：真凶仅派生字段可见时，
# 规则 type 0.000 / 模型 1.000）。它们不是装饰，是输入契约的一部分。
#
# 判据来自语料测量，不是估计：在 train/test/ood/adversarial 共 10,332 张图、207,356 个节点实例上，
# 这 5 个字段**没有一个为空**（0/207356）。
#
# v2 之后它们**不再是 fail-closed 的闸门**：真实 uBuddy 节点上一个都没有来源
# （见 ubuddy_contract_probe.mjs / ubuddy_model_probe.py），拿它们当闸门等于把整条链路恒关。
# 闸门改成按 kind 取必需集，见下面的 REQUIRED_FIELDS_BY_KIND。这两个常量保留下来，
# 因为「语料的 5 字段不变量」仍然是语料侧要守的东西，只是不再用来判线上输入。
RICH_NODE_FIELDS = ("artifact", "stage", "inputs", "output", "summary")

# ---------------------------------------------------------------------------
# 分层契约 v2：必需字段按 kind 分（与 lib 侧同一套判据）
# ---------------------------------------------------------------------------
#
# v1 判据「每个节点 5 个富文本全非空」在语料上是硬不变量，但在真实数据上永远不可能满足，
# 于是恒定 fail-closed 到 record_only —— 守卫没错，是它守错了地方。
#
# v2 按 kind 分级，取值由两条准入规则算出（与 uBuddyPlanExec.js 逐字一致）：
#   (a) 该字段对该层有真实来源，且不是 missing / constant / inherited；
#   (b) 该字段对模型可见。
#
# (b) 在 Python 侧是**结构性成立**的：下面只看 `public_graph` 投影后的值，
# 而 `public_graph` 就是模型读到的那个 payload。判据不可能越过可见范围去要求一个字段。
#
# `status` 是 step 层唯一真正的漂移信号（被砍掉的 step 会被投影标成 cancelled），
# 但它要等 P2 与两侧 prompt 一起进 `NODE_FIELDS`。所以这里写的是 v4 的**完整意图**，
# `required_fields_for_kind` 才是生效集合（声明 ∩ 可见）。
DECLARED_REQUIRED_FIELDS_BY_KIND = {
    "root": ("title",),
    "ubuddy": ("title",),
    "agent_task": ("title", "summary", "output"),
    "agent_step": ("title", "status"),
}

# 准入规则 (c)：字段还分**哪一侧写得出来**。
#
# (a)(b) 只说了「这一层有没有独立来源」和「模型看不看得见」，但真实投影还有第三个维度：
# G_plan 与 G_prime 的字段来源不一样。规划图的两个来源是
# `proposalNodesFromTaskRun`（只带 localId/title/agentId/dependencies）与首版 plan step
# （只有 label/status），**都没有 outcome 文本**；执行图才有 summary ← public_summary、
# output ← task_nodes.result_text。所以在规划侧要求这两个字段的后果不是「更严」，
# 而是每个真实群任务稳定产生两条缺口、产品路径永远出不了 record_only。
SIDES = ("plan", "exec")

FIELD_SIDES = {
    "summary": ("exec",),
    "output": ("exec",),
    "title": ("plan", "exec"),
    "agentId": ("plan", "exec"),
    "role": ("plan", "exec"),
    "version": ("plan", "exec"),
    "acceptance": ("plan", "exec"),
    "status": ("plan", "exec"),
    "artifact": ("plan", "exec"),
    "stage": ("plan", "exec"),
    "inputs": ("plan", "exec"),
}

# kind 缺失时按**最严**一档判，不静默放宽。旧平铺图的节点没有 kind，语义上就是 agent_task。
CONTRACT_FALLBACK_KIND = "agent_task"

# 某一层上「有值、但不是该层独立信号」的字段 —— 准入规则 (a) 里的 inherited。
# agent_step.agentId == parent.agentId（投影代码里 plan 侧与 exec 侧都确认过），
# 父节点没变它就一定不变，所以不能当独立信号收进必需集。
INHERITED_FIELDS_BY_KIND = {
    "agent_step": ("agentId", "role", "version", "acceptance",
                   "artifact", "stage", "inputs", "output", "summary"),
}


def plan_exec_side(value) -> str:
    """某一侧的合法取值；非法值按最严的 exec 处理，不静默放宽。"""
    clean = _text(value, 16)
    return clean if clean in SIDES else "exec"


def field_exists_on_side(field: str, side: str) -> bool:
    """该字段在该侧有没有来源（准入规则 (c)）。未登记的字段按「两侧都有」处理。"""
    sides = FIELD_SIDES.get(field)
    if sides is None:
        return True
    return plan_exec_side(side) in sides


def declared_required_fields_for_kind(kind, side="exec") -> tuple:
    """v4 的完整意图，可能包含尚未对模型可见的字段。不要直接拿它当闸门。

    已按 (c) 去掉该侧投影写不出的字段（规划侧的 summary/output）。
    """
    declared = DECLARED_REQUIRED_FIELDS_BY_KIND.get(
        _text(kind, 40), DECLARED_REQUIRED_FIELDS_BY_KIND[CONTRACT_FALLBACK_KIND])
    return tuple(field for field in declared if field_exists_on_side(field, side))


def required_fields_for_kind(kind, side="exec") -> tuple:
    """**生效**必需集 = 声明必需集 ∩ 模型可见字段 ∩ 该侧写得出的字段。

    准入规则 (b)(c) 在这里被结构性保证：判据不可能要求一个模型读不到的字段，
    也不可能要求一侧投影写不出的字段，因为取不到。
    P2 把 `status` 加进 `NODE_FIELDS` 时，step 一档会自动从「只判 title」收紧成
    「title + status」，与 JS 侧一处改动同时生效。
    """
    return tuple(field for field in declared_required_fields_for_kind(kind, side) if field in NODE_FIELDS)


def deferred_required_fields() -> dict:
    """声明了、但因为对模型不可见而暂时不生效的必需字段，按 `侧/kind` 列出。

    让「故意延后」可见：过滤本身安全，但不报出来的话，忘记同步 prompt 的人
    会以为 step 层已经在判 status 了。
    """
    return {
        f"{side}/{kind}": [field for field in declared_required_fields_for_kind(kind, side)
                           if field not in NODE_FIELDS]
        for side in SIDES
        for kind in DECLARED_REQUIRED_FIELDS_BY_KIND
        if any(field not in NODE_FIELDS for field in declared_required_fields_for_kind(kind, side))
    }


class InputContractError(ValueError):
    """输入不满足模型的训练契约。

    必须 fail-closed：`public_graph` 会把缺失字段归一成空字符串，于是 prompt **照常构建成功**、
    `validate_verdict` **照常返回空警告**，模型照样给一个自信的判定 —— 只是那个判定不再代表任何
    已测得的准确率。这是最隐蔽的一种降级，所以在这里硬拦，而不是靠调用方自觉。
    """


# ---------------------------------------------------------------------------
# 归一化：逐字节复刻 lib/graph.mjs 的 normalizeRichGraph + lib/sft.mjs 的 publicGraph
# ---------------------------------------------------------------------------

# JS 的 /\s/（非 unicode flag）与 Python 的 \s 不完全相同：Python 多 \x1c-\x1f 和 \x85，
# JS 多 \ufeff。既然目标是逐字节一致，就把 JS 的那个集合写死。
_JS_WS = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_WS_RUN = re.compile(f"[{_JS_WS}]+")


def _js_slice(text: str, max_len: int) -> str:
    """JS 的 String.prototype.slice 按 UTF-16 码元计数，Python 按码点。

    对 BMP 之外的字符（如 emoji）两者会差 1，截断位置一旦落在代理对中间还会产生
    lone surrogate。这里对齐 JS 的计数方式，避免长字段截断位置漂移。
    """
    units = text.encode("utf-16-le", "surrogatepass")
    if len(units) <= max_len * 2:
        return text
    return units[: max_len * 2].decode("utf-16-le", "ignore")


def _text(value, max_len: int = 240) -> str:
    """JS `String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max)` 的等价实现。"""
    # JS 的 `|| ''` 对所有 falsy 值都归零。字段都是标量字符串，这里覆盖 None/''/0/False。
    raw = str(value) if value else ""
    return _js_slice(_WS_RUN.sub(" ", raw).strip(), max_len)


def public_graph(value) -> dict:
    """把一棵原始树投影成喂给模型的公开形状（去掉 label/内部字段）。

    必须与 lib/sft.mjs#publicGraph 完全一致：节点的空 id 会被丢弃、边在端点不存在或
    自环时会被丢弃、`agentId`/`version`/`acceptance` 有默认值、所有文本会被折叠空白并截断。
    """
    source = value if isinstance(value, dict) else {}

    nodes = []
    for node in source.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        item = {
            "id": _text(node.get("id") or node.get("nodeId"), 80),
            "title": _text(node.get("title")),
            "role": _text(node.get("role"), 80),
            "agentId": _text(node.get("agentId"), 160) or "agent",
            "version": _text(node.get("version"), 80) or "v1",
            "acceptance": _text(node.get("acceptance"), 80) or "standard",
            "artifact": _text(node.get("artifact")),
            "stage": _text(node.get("stage"), 80),
            "inputs": _text(node.get("inputs"), 600),
            "output": _text(node.get("output"), 600),
            "summary": _text(node.get("summary"), 800),
            # P2：与 lib/sft.mjs#publicGraph 同步。**注意这里刻意不给默认值。**
            #
            # status 不是 agentId/version/acceptance 那类"常量而非信号"的字段，它是
            # agent_step 层唯一的漂移信号。缺省成 'completed' 会让"投影根本没记录执行状态"
            # 这件事被悄悄抹平 —— 那正是 fail-closed 要拦的降级。所以空就是空，
            # 由 check_case_contract 判成 empty_status。
            #
            # 语料侧不存在这个歧义：normalizeRichGraph 会给每个节点补上基线，
            # 写进 JSONL 的行都带显式 status，所以两侧 prompt 仍然逐字节一致。
            "status": _text(node.get("status"), 40),
        }
        if item["id"]:
            nodes.append(item)

    ids = {node["id"] for node in nodes}
    edges = []
    for edge in source.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        # 注意 id 的兜底用的是默认 240 上限，不是 160 —— 与 JS 一致。
        item = {
            "id": _text(edge.get("id"), 160) or f"{_text(edge.get('from'))}->{_text(edge.get('to'))}",
            "from": _text(edge.get("from"), 80),
            "to": _text(edge.get("to"), 80),
        }
        if item["from"] in ids and item["to"] in ids and item["from"] != item["to"]:
            edges.append(item)

    return {
        "domain": _text(source.get("domain"), 80),
        "title": _text(source.get("title")),
        "topic": _text(source.get("topic"), 160),
        "nodes": nodes,
        "edges": edges,
    }


def node_ids(*graphs) -> set[str]:
    """一次调用里所有出现过的节点 id（用于校验 nodeId / evidenceNodeIds）。"""
    ids: set[str] = set()
    for graph in graphs:
        for node in public_graph(graph)["nodes"]:
            ids.add(node["id"])
    return ids


def node_kind_lookup(raw_graph) -> dict:
    """原始图上的 id -> kind。

    kind 是选档用的**选择器**，不是模型输入：契约用它决定必需集，但永远不把它塞进 prompt
    （prompt 里多一个字段就会偏离训练分布）。所以这里从**原始** case 取，从投影后的
    `public_graph` 里是拿不到的。id 冲突时与 normalizeRichGraph 一样「先出现的赢」。
    """
    lookup: dict[str, str] = {}
    source = raw_graph if isinstance(raw_graph, dict) else {}
    for node in source.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        node_id = _text(node.get("id") or node.get("nodeId"), 80)
        if not node_id or node_id in lookup:
            continue
        lookup[node_id] = _text(node.get("kind"), 40) or CONTRACT_FALLBACK_KIND
    return lookup


def check_case_contract(case: dict) -> list[str]:
    """这条输入是否落在训练支持集内？返回问题列表，空列表表示可以推理。

    在 `public_graph` 投影**之后**检查，因为那正是模型真正看到的东西：字段在原始入参里叫什么
    （`inputs` 还是别的）不重要，重要的是投影出来后模型能读到内容。空字符串 = 模型读到的是空。
    这也让准入规则 (b)「判据必须对模型可见」结构性成立。

    必需集**按 kind**（`required_fields_for_kind`），kind 从原始 case 取、不从投影取。
    旧平铺图的节点没有 kind，回退到最严的 agent_task 一档。
    """
    problems: list[str] = []
    # 两侧用**不同**的必需集：规划图是意图，执行图是结果，来源不同。
    for name, side in (("G_star", "plan"), ("G_prime", "exec")):
        raw = case.get(name)
        graph = public_graph(raw)
        if not graph["nodes"]:
            problems.append(f"{name}:no_nodes")
            continue
        kinds = node_kind_lookup(raw)
        for node in graph["nodes"]:
            kind = kinds.get(node["id"], CONTRACT_FALLBACK_KIND)
            for field in required_fields_for_kind(kind, side):
                if not node.get(field):
                    problems.append(f"{name}:{node['id']}:empty_{field}")
    return problems


def summarize_contract_problems(problems: list[str], limit: int = 3) -> str:
    """只取前几条 + 总数：一根 20 节点图缺 5 个字段会产生 200 条问题，全塞进记录会撑爆输出。"""
    if len(problems) <= limit:
        return ";".join(problems)
    return f"{';'.join(problems[:limit])}(+{len(problems) - limit} more)"


# ---------------------------------------------------------------------------
# prompt
# ---------------------------------------------------------------------------

def build_prompt(g_star, g_prime) -> str:
    """构造与训练时逐字节一致的 prompt。

    `separators=(",", ":")` 是必须的：JS 的 JSON.stringify 不插空格，而 Python 的
    json.dumps 默认插 `, ` / `: `。少这个参数，prompt 会多出大量空格 —— 模型仍能工作，
    但已经偏离训练分布。`ensure_ascii=False` 同理（JS 不转义非 ASCII）。
    """
    payload = {"G_star": public_graph(g_star), "G_prime": public_graph(g_prime)}
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    return f"{DETECTIVE_INSTRUCTION}\nINPUT={body}"


def build_case_prompt(case: dict) -> str:
    """case 级入口。**唯一**的推理咽喉，守卫挂在这里，`Detective` 绕不过去。"""
    problems = check_case_contract(case)
    if problems:
        raise InputContractError(
            f"input outside the trained contract: {summarize_contract_problems(problems)}"
        )
    return build_prompt(case["G_star"], case["G_prime"])


# ---------------------------------------------------------------------------
# 输出解析与校验
# ---------------------------------------------------------------------------

def _blank(status: str = "UNKNOWN", parse_error: bool = False) -> dict:
    return {
        "status": status, "nodeId": "", "edgeId": "", "type": "",
        "evidenceNodeIds": [], "parseError": parse_error,
    }


def parse_completion(text: str) -> dict:
    """容错解析模型输出。

    比训练时的 gold 多一些容忍：模型可能套 ```json 围栏、或前后带一句解释。
    解析失败不抛异常 —— 返回 `status=UNKNOWN, parseError=True`，让调用方自己决定，
    因为「模型答不出」和「模型答错了」在线上是两回事。
    """
    raw = str(text or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?", "", raw).strip()
        raw = raw.split("```", 1)[0].strip()
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        return _blank(parse_error=True)
    try:
        value = json.loads(match.group(0))
    except json.JSONDecodeError:
        return _blank(parse_error=True)
    if not isinstance(value, dict):
        return _blank(parse_error=True)

    status = value.get("status") if value.get("status") in STATUSES else "UNKNOWN"
    type_name = value.get("type") if value.get("type") in DRIFT_TYPES else ""
    evidence = value.get("evidenceNodeIds")
    evidence = evidence if isinstance(evidence, list) else []
    return {
        "status": status,
        "nodeId": str(value.get("nodeId") or ""),
        "edgeId": str(value.get("edgeId") or ""),
        # v3 语义：非 drift 的答案不得携带 type（no_drift / UNKNOWN 都是弃权）。
        "type": type_name if status == "drift" else "",
        "evidenceNodeIds": [str(item) for item in evidence],
        "parseError": False,
    }


def validate_verdict(verdict: dict, valid_node_ids) -> list[str]:
    """语义校验。返回警告列表，空列表表示这条判定自洽且可追溯到图。

    存在的意义：模型能（且确实会）编出一个格式合法但图里不存在的 nodeId。
    只校验 JSON schema 抓不到这种错，而它对下游是致命的 —— 会让你去查一个不存在的节点。
    """
    warnings: list[str] = []
    if verdict.get("parseError"):
        warnings.append("parse_error")
        return warnings

    status = verdict.get("status")
    node = verdict.get("nodeId") or ""
    if status == "drift":
        if not node:
            warnings.append("drift_without_nodeId")
        elif node not in valid_node_ids:
            warnings.append(f"nodeId_not_in_graph:{node}")
        if not verdict.get("type"):
            warnings.append("drift_without_type")
    else:
        # v3 契约：no_drift / UNKNOWN 必须弃权，不得指认凶手。
        if node:
            warnings.append(f"non_drift_has_nodeId:{node}")
        if verdict.get("type"):
            warnings.append(f"non_drift_has_type:{verdict['type']}")

    for item in verdict.get("evidenceNodeIds") or []:
        if item and item not in valid_node_ids:
            warnings.append(f"evidence_not_in_graph:{item}")
    return warnings


# ---------------------------------------------------------------------------
# 模型
# ---------------------------------------------------------------------------

class Detective:
    """Qwen3-8B + LoRA adapter 的确定性推理封装。

    贪心解码（`do_sample=False`）、`enable_thinking=False`、`max_new_tokens=160` ——
    与评测脚本 `scripts/eval_rdmd_qlora.py` 完全一致。评测数字是在这组参数下取得的，
    换采样参数会让它不再成立。
    """

    def __init__(self, model: str, adapter: str = "", device: str = "cuda:0", max_new_tokens: int = 160):
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.max_new_tokens = max_new_tokens
        self.tokenizer = AutoTokenizer.from_pretrained(adapter or model, trust_remote_code=True)
        if self.tokenizer.pad_token_id is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token
        base = AutoModelForCausalLM.from_pretrained(
            model, dtype=torch.bfloat16, device_map={"": device}, trust_remote_code=True
        )
        self.model = PeftModel.from_pretrained(base, adapter) if adapter else base
        self.model.eval()
        self._torch = torch

    def predict(self, case: dict) -> dict:
        """单条：输入 `{G_star, G_prime}`，输出判定。"""
        return self.predict_many([case])[0]

    def predict_many(self, cases: list[dict]) -> list[dict]:
        torch = self._torch
        results = []
        for case in cases:
            prompt = build_case_prompt(case)
            messages = [{"role": "user", "content": prompt}]
            encoded = self.tokenizer.apply_chat_template(
                messages, tokenize=True, add_generation_prompt=True,
                enable_thinking=False, return_tensors="pt",
            )
            if hasattr(encoded, "keys"):
                prompt_ids = encoded["input_ids"]
                attention_mask = encoded.get("attention_mask")
            else:
                prompt_ids = encoded
                attention_mask = None
            prompt_ids = prompt_ids.to(self.model.device)
            gen_kwargs = {"max_new_tokens": self.max_new_tokens, "do_sample": False}
            if attention_mask is not None:
                gen_kwargs["attention_mask"] = attention_mask.to(self.model.device)
            with torch.no_grad():
                generated = self.model.generate(prompt_ids, **gen_kwargs)
            text = self.tokenizer.decode(generated[0][prompt_ids.shape[-1]:], skip_special_tokens=True)

            verdict = parse_completion(text)
            warnings = validate_verdict(verdict, node_ids(case["G_star"], case["G_prime"]))
            results.append({
                "id": case.get("id", ""),
                "verdict": {key: verdict[key] for key in VERDICT_FIELDS},
                "raw": text,
                "valid": not warnings,
                "warnings": warnings,
            })
        return results


def read_cases(path: Path) -> list[dict]:
    """读输入。支持三种：单个 case 的 .json、case 数组的 .json、每行一个 case 的 .jsonl。"""
    text = Path(path).read_text(encoding="utf-8-sig")
    stripped = text.strip()
    if stripped.startswith("["):
        cases = json.loads(stripped)
    elif stripped.startswith("{"):
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError:
            # 退化情形：无外层数组的 JSONL。
            cases = [json.loads(line) for line in stripped.splitlines() if line.strip()]
        else:
            # 单个 case（有 G_star/G_prime）还是 {"cases": [...]} 包装。
            cases = value.get("cases") if isinstance(value, dict) and "cases" in value else [value]
    else:
        cases = [json.loads(line) for line in stripped.splitlines() if line.strip()]
    if not isinstance(cases, list) or not cases:
        raise ValueError(f"no cases found in {path}")
    for index, case in enumerate(cases):
        if not isinstance(case, dict) or "G_star" not in case or "G_prime" not in case:
            raise ValueError(f"case #{index} missing G_star/G_prime")
    return cases
