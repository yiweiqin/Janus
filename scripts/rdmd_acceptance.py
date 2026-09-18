"""Mechanical go/no-go for an RDMD adapter: is this model usable?

"Usable" has to mean something specific or it degenerates into reading a dashboard. The criteria are
anchored to measured baselines (V3_FULL_REPORT.zh-CN.md sections 3 and 6):

  Rule D/E localises the culprit at 1.0000 and abstains at 1.0000 on test. So on localisation the
  model can at best TIE an 11-line graph algorithm -- it can never win there. The axes where a model
  must show something real are therefore:
    * abstention, where v2 scored 0.000 and never once declined to answer;
    * the subset of drift rows whose culprit has NO changed cause field (~47% of them), which cannot
      be read off a field and can only be solved by rebuilding the dependency order;
    * type, where the baseline is 0.527.

Scores alone are not enough: a model that cannot emit parseable JSON is unusable regardless, so a
parse-error guard is part of the verdict.

Usage:
  python scripts/rdmd_acceptance.py --run-tag qlora-v3
  python scripts/rdmd_acceptance.py --eval-dir experiments/rdmd_runs/eval-qlora-v3

Exit codes: 0 usable, 1 not usable, 2 not enough data yet.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from eval_rdmd_qlora import parse_completion  # noqa: E402

ROOT = SCRIPTS.parent
DEFAULT_SFT = ROOT / "experiments" / "rdmd_detective_dataset" / "sft"
DEFAULT_DATA = ROOT / "experiments" / "rdmd_detective_dataset" / "data"
CAUSE_FIELDS = ("inputs", "agentId", "version", "acceptance")

# 与 lib/graph.mjs#DEFAULT_NODE_STATUS 逐字一致：status 只剩"与基线不同"这一种信息。
DEFAULT_NODE_STATUS = "completed"


@dataclass
class Criterion:
    key: str
    label: str
    split: str
    group: str
    metric: str
    threshold: float
    why: str
    value: float | None = None
    n: int = 0
    lower_is_better: bool = False

    @property
    def ok(self) -> bool:
        if self.value is None:
            return False
        return self.value <= self.threshold if self.lower_is_better else self.value >= self.threshold


def load_json(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError:
        return None


def read_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_provenance(eval_dir: Path, sft_dir: Path) -> tuple[dict | None, list[str]]:
    """取出「这份判决书判的是谁」：哪份权重、哪批标签、哪版 prompt 构造函数。

    以前 `acceptance.json` 只写 `evalDir: .../eval-qlora-v4`，也就是「谁判的」要靠目录名
    反推 —— 换个目录、或者同一个目录里重跑一次，结论就和权重脱钩了。P3 停掉重建第一次
    起训，病因正是同一个：v4 的 `run_manifest.json` 里写着 v3 的 dataKind。云侧判定早就
    强制带 `adapter_sha256`，验收这份唯一 go/no-go 证据没有理由例外。

    这里是**记录 + 核对**，不是新的失败门。标签哈希对不上时给一条明确的 note，但**不改
    判定**：判定该不该翻已经由覆盖度守卫管（交集塌了就判「未测到」），在出处上再加一道
    门只会引入一类新的假失败 —— 本地重新生成过语料就会亮红，哪怕内容其实一字不差。
    核对结论逐 split 落盘，读的人不必猜。
    """
    manifest = load_json(eval_dir / "eval_manifest.json")
    if manifest is None:
        return None, ["eval_manifest.json 缺失：本次结论未绑定被评测的权重与标签，出处无记录"]

    notes: list[str] = []
    splits = (manifest.get("sft") or {}).get("splits") or {}
    integrity: dict[str, dict] = {}
    for split, info in sorted(splits.items()):
        expected = (info or {}).get("sha256")
        actual = sha256_file(sft_dir / f"{split}.jsonl")
        if expected is None or actual is None:
            # 本地没有这个 split 的文件 = 无从核对，与「不一致」是两件事，不能混报。
            match: bool | None = None
        else:
            match = expected == actual
        integrity[split] = {"expected": expected, "actual": actual, "match": match}

    manifest["labelIntegrity"] = integrity
    mismatched = sorted(split for split, row in integrity.items() if row["match"] is False)
    manifest["labelIntegrityOk"] = not mismatched
    for split in mismatched:
        notes.append(
            f"标签哈希对不上：{split} 的本地 sft 与评测时读的那批不是同一份 —— "
            "逐行指标（无原因字段子集、step 层）建立在两批不同标签的交集上，不可信"
        )
    return manifest, notes


def print_provenance(provenance: dict | None) -> None:
    if provenance is None:
        print("provenance: 未记录（eval_manifest.json 缺失）—— 结论无法归属到具体权重")
        return
    adapter = provenance.get("adapter") or {}
    sft = provenance.get("sft") or {}
    evaluator = provenance.get("evaluator") or {}
    checksum = (adapter.get("sha256") or "n/a")[:16]
    source = provenance.get("source") or "unknown"
    print(f"provenance: runTag={provenance.get('runTag')} source={source} adapter={checksum} "
          f"bytes={adapter.get('bytes')} base={adapter.get('baseModel')}")
    if source != "launch":
        print(f"            注意: source={source} —— 这份出处不是起跑时抓的，证据力弱于 launch")
    print(f"            sft schemaVersion={sft.get('schemaVersion')} "
          f"sourceVersion={sft.get('sourceVersion')}")
    print(f"            evaluator(prompt 构造函数) sha256={(evaluator.get('sha256') or 'n/a')[:16]}")
    integrity = provenance.get("labelIntegrity") or {}
    if integrity:
        # ASCII 标记：Windows 控制台是 GBK，✓/✗ 会被打烂，核对结论反而看不清。
        marks = []
        for split, row in integrity.items():
            mark = {True: "OK", False: "MISMATCH", None: "n/a"}[row["match"]]
            marks.append(f"{split}={mark}")
        print(f"            标签核对: {' '.join(marks)}  (OK=与评测时一致 / MISMATCH=不一致 / n/a=本地缺该 split)")


def parse_prompt_input(prompt: str) -> dict:
    index = prompt.find("INPUT=")
    return json.JSONDecoder().raw_decode(prompt[index + len("INPUT="):].lstrip())[0]


def node_in(graph: dict, node_id: str) -> dict | None:
    for node in graph.get("nodes") or []:
        if node.get("id") == node_id:
            return node
    return None


def derived_only_rows(sft_rows: list[dict]) -> tuple[list[str], int]:
    """Drift rows where the gold node's cause fields are identical in both trees.

    Returns (ids of those rows, total drift rows). This is the subset that has no short field-level
    signal -- the ~47% that requires actually rebuilding the dependency order to solve. The fraction
    is asserted against the published baseline so a silent change in this definition cannot go unseen.
    """
    ids: list[str] = []
    drift_total = 0
    for row in sft_rows:
        gold = json.loads(row["completion"])
        if gold["status"] != "drift":
            continue
        drift_total += 1
        payload = parse_prompt_input(row["prompt"])
        star = node_in(payload.get("G_star") or {}, gold["nodeId"])
        prime = node_in(payload.get("G_prime") or {}, gold["nodeId"])
        if star is None or prime is None:
            continue
        if all(str(star.get(f, "")) == str(prime.get(f, "")) for f in CAUSE_FIELDS):
            ids.append(row["id"])
    return ids, drift_total


def subset_metric(sft_rows: list[dict], preds: dict[str, dict]) -> tuple[float | None, int, int]:
    ids, drift_total = derived_only_rows(sft_rows)
    if not ids:
        return None, 0, drift_total
    wanted = set(ids)
    correct = 0
    for row in sft_rows:
        if row["id"] not in wanted:
            continue
        gold = json.loads(row["completion"])
        pred = preds.get(row["id"])
        if pred and pred["status"] == "drift" and pred["nodeId"] == gold["nodeId"]:
            correct += 1
    return correct / len(ids), len(ids), drift_total


def gold_kind_map(data_dir: Path) -> dict[str, str]:
    """`样本 id → 真凶节点所在的层`。**只能从原始 case 读。**

    prompt 里没有 `kind` —— `lib/sft.mjs#publicGraph` 刻意只放可见字段，`kind` 只给分层加权
    用（进了 prompt 模型就能靠"这个节点在第几层"作弊）。所以从 SFT 行里是拿不到
    "这一行考的是哪一层"的，必须回到 `data/*.jsonl`。

    缺 `kind` 即平铺族，回退 `agent_task` —— 与两侧契约的 `CONTRACT_FALLBACK_KIND` 同义。
    """
    kinds: dict[str, str] = {}
    for name in ("train", "development", "test"):
        for row in read_jsonl(data_dir / f"{name}.jsonl"):
            label = row.get("label") or {}
            if label.get("status") != "drift":
                continue
            node = node_in(row.get("G_star") or {}, label.get("injected_node") or "")
            kinds[row["id"]] = (node or {}).get("kind") or "agent_task"
    return kinds


def _status_rank(status: str) -> int:
    """状态越"坏"排越前。与 validate.mjs#statusShortcutBaseline 的 rankOf 逐条同义。"""
    if status in ("cancelled", "failed"):
        return 0
    if status in ("blocked", "running"):
        return 1
    if status and status != DEFAULT_NODE_STATUS:
        return 2
    return 3


def _numeric_label(node_id: str) -> int:
    """`n7` → 7。没有数字的 id 排最后，避免 'lowest id' 这条捷径在无编号图上随机取胜。"""
    digits = "".join(ch for ch in str(node_id) if ch.isdigit())
    return int(digits) if digits else 1 << 30


def status_shortcut_score(raw_dir: Path, ids: set[str], preds: dict[str, dict]) -> dict:
    """只看 `status` 的规则在这批行上能得多少分 —— 外加模型在同一批行上的分数。

    为什么要有这一项：`status` 是 v4 新放进 prompt 的**强**信号。如果语料里"谁的状态变了"
    几乎等于答案，模型完全可以只学会读 status，而 step 层收窄加上这条通道就白做了。
    数据集侧已有一条守卫（`validate.mjs#statusShortcutBaseline`，阈值 0.35），但那只证明
    **语料**不能让这条捷径取胜；这里要证明的是**模型**没有退化成这条捷径 ——
    两件事，缺一不可（语料够干净，模型仍可能偷懒地只学那一个字段）。

    判据取的是「模型 − 捷径」的差，而不是捷径的绝对值：绝对值低但模型一样低，说明模型没学到
    东西；绝对值和模型都高，说明这条通道确实太强，不该放行。

    只在**模型给出可解析预测**的行上算，这样两边是同一批行、同一个分母。
    """
    n = 0
    shortcut_hits = 0
    model_hits = 0
    for name in ("train", "development", "test"):
        for row in read_jsonl(raw_dir / f"{name}.jsonl"):
            if row["id"] not in ids or row["id"] not in preds:
                continue
            label = row.get("label") or {}
            if label.get("status") != "drift":
                continue
            pred = preds[row["id"]]
            if pred["status"] != "drift":
                continue
            changed = [node for node in (row.get("changed_node_ids") or []) if node]
            if not changed:
                continue
            n += 1
            gold = label.get("injected_node") or ""
            if gold and pred["nodeId"] == gold:
                model_hits += 1
            star = {node["id"]: node.get("status", "") for node in (row.get("G_star") or {}).get("nodes") or []}
            prime = {node["id"]: node.get("status", "") for node in (row.get("G_prime") or {}).get("nodes") or []}
            moved = [node for node in changed
                     if node in star and node in prime and star[node] != prime[node]]
            pool = moved or changed
            pick = sorted(pool, key=lambda node: (_status_rank(prime.get(node, "")),
                                                  _numeric_label(node)))[0]
            if pick == gold:
                shortcut_hits += 1
    if not n:
        return {"n": 0, "top1": None, "modelNodeHit": None, "gap": None}
    top1 = shortcut_hits / n
    model_hit = model_hits / n
    return {"n": n, "top1": top1, "modelNodeHit": model_hit, "gap": model_hit - top1}


def collect(eval_dir: Path, sft_dir: Path, primary_split: str = "test",
            data_dir: Path | None = None) -> tuple[list[Criterion], list[str], dict]:
    notes: list[str] = []
    criteria = [
        Criterion("primary_node", f"{primary_split} 定位（nodeId Top-1）", primary_split, "drift", "nodeHit", 0.95,
                  "基线 D/E = 1.000，模型上限只是打平；低于此说明连规则复现都没做到"),
        Criterion("primary_type", f"{primary_split} 类型（type Top-1）", primary_split, "drift", "typeHit", 0.60,
                  "基线 0.527；v2 0.997 但那是短路数据上的数字，不代表能力"),
        Criterion("unknown_abstain", "UNKNOWN 弃权率", "eval_unknown", "UNKNOWN", "unknownRate", 0.80,
                  "v2 = 0.000（185 行全答 drift）——v3 最核心的短板"),
        Criterion("no_drift", "no_drift 正确率", "eval_no_drift", "no_drift", "statusHit", 0.95,
                  "基线 1.000；两树相同必须判得稳"),
    ]

    reports: dict[str, dict] = {}
    for name in {primary_split, "eval_unknown", "eval_no_drift"}:
        report = load_json(eval_dir / f"{name}.report.json")
        if report is None:
            notes.append(f"missing report: {name}.report.json")
            continue
        reports[name] = report

    for criterion in criteria:
        report = reports.get(criterion.split)
        if not report:
            continue
        group = (report.get("metrics") or {}).get(criterion.group)
        if not group:
            notes.append(f"{criterion.split} has no '{criterion.group}' group")
            continue
        criterion.value = float(group.get(criterion.metric, 0.0))
        criterion.n = int(group.get("n", 0))

    # Derived-only subset: needs per-row predictions, not just the per-status aggregates.
    #
    # 先做一次**覆盖度**判据，再算任何逐行指标。理由：这些指标的分子分母都来自
    # `sft/<split>.jsonl` 与 `merged.predictions.jsonl` 的交集，而两者可以来自**不同的
    # 数据集版本**（比如拿 v4 的 sft 去配 v3 的评测产物）。那种情况下交集会只剩个位数，
    # 指标照常打印出一个四位数的小数 —— 看起来像结论，其实是噪声。
    # 实测踩到过：v3 的产物配 v4 的 sft，step 层这项报 n=5 / 1.0000，"
    # 无原因字段子集"报 0.0799。两个都是假的，而且没有任何报错。
    # 所以覆盖度不够时**不输出这些指标**，标成"未测到"（未测到即不可用，不是通过）。
    preds: dict[str, dict] = {}
    merged = eval_dir / "merged.predictions.jsonl"
    if merged.is_file():
        for row in read_jsonl(merged):
            preds[row["id"]] = parse_completion(row.get("prediction") or "")
    test_rows = read_jsonl(sft_dir / f"{primary_split}.jsonl")
    expected_derived = 0.0

    split_ids = {row["id"] for row in test_rows}
    covered = split_ids & set(preds)
    coverage = (len(covered) / len(split_ids)) if split_ids else 0.0
    per_row_usable = bool(preds) and bool(test_rows) and coverage >= 0.9
    if preds and test_rows and not per_row_usable:
        notes.append(
            f"predictions cover only {len(covered)}/{len(split_ids)} ({coverage:.1%}) of {primary_split}: "
            "the eval dir and the sft dir look like different dataset versions. Per-row criteria "
            "(derived-only / step-layer / status-shortcut) are suppressed rather than reported on a "
            "near-empty overlap."
        )

    if per_row_usable:
        value, n, drift_total = subset_metric(test_rows, preds)
        expected_derived = 1 - 0.5270  # published rule-A coverage on test
        if drift_total and abs(n / drift_total - expected_derived) > 0.05:
            notes.append(
                f"derived-only subset is {n / drift_total:.3f} of drift rows, expected ~{expected_derived:.3f}; "
                "the definition may have drifted from the published baseline"
            )
    else:
        value, n = None, 0
        notes.append("no usable merged.predictions.jsonl: derived-only subset not scored")
    criteria.append(Criterion("primary_derived_only", f"{primary_split} 无原因字段子集定位", primary_split, "drift", "nodeHit", 0.90,
                              "真凶在原因字段上无标记的 ~47% 行；只能靠重建依赖序解出，是真正考推理的一档",
                              value=value, n=n))

    # v4 第 7 项：step 层还有没有用。
    #
    # 缩窄之后 step 节点只剩 title / status / agentId 三个有来源的字段，漂移的后果落在
    # 下游 agent_task 的富文本上。所以这一项量的不是"step 层自己够不够"，而是
    # **缩窄有没有把这一层的能力砍没**：真凶在 step 层时，模型还能不能把它挑出来。
    # 没有这一项就无法判断缩窄的代价，而缩窄正是 v4 的全部内容。
    step_kinds = gold_kind_map(data_dir) if data_dir else {}
    step_value, step_n = None, 0
    if per_row_usable and step_kinds:
        step_ids = {row_id for row_id, kind in step_kinds.items()
                    if kind == "agent_step" and row_id in split_ids}
        hits = 0
        scored = 0
        for row in test_rows:
            if row["id"] not in step_ids:
                continue
            pred = preds.get(row["id"])
            if pred is None:
                continue
            scored += 1
            gold = json.loads(row["completion"])
            if pred["status"] == "drift" and pred["nodeId"] == gold["nodeId"]:
                hits += 1
        step_n = scored
        step_value = (hits / scored) if scored else None
        if not scored:
            notes.append("no agent_step gold rows in the primary split: step-layer criterion not scored")
    else:
        notes.append("need usable predictions and data/: step-layer criterion not scored")
    criteria.append(Criterion("step_layer_node", f"{primary_split} 真凶在 step 层的定位", primary_split, "drift", "nodeHit", 0.90,
                              "step 层收窄后只剩 title/status/agentId；低于 0.90 说明缩窄把这一层砍没了，"
                              "那这一层就不该留在契约里", value=step_value, n=step_n))

    # v4 第 8 项：模型没有退化成"只读 status"。
    gap_value, gap_n = None, 0
    if per_row_usable and data_dir:
        shortcut = status_shortcut_score(data_dir, split_ids, preds)
        gap_value, gap_n = shortcut["gap"], shortcut["n"]
        if shortcut["top1"] is None:
            notes.append("status shortcut could not be scored (no drift row with changed nodes)")
        else:
            notes.append(
                f"status shortcut top1={shortcut['top1']:.4f}, model={shortcut['modelNodeHit']:.4f} "
                f"on the same {shortcut['n']} rows"
            )
            if shortcut["top1"] > 0.35:
                notes.append(
                    "status shortcut alone beats the 0.35 dataset guard: the corpus guard should have caught this, "
                    "check validate.mjs#statusShortcutBaseline"
                )
    else:
        notes.append("need usable predictions and data/: status-shortcut criterion not scored")
    criteria.append(Criterion("status_shortcut", f"{primary_split} 模型 − 只看 status 的捷径（差）", primary_split, "drift",
                              "nodeHit", 0.25,
                              "status 是 v4 新放进 prompt 的强信号。差距不够大说明模型可能只是学会了读 status —— "
                              "那 step 层收窄加这条通道就白做了（语料守卫另有 validate.mjs#statusShortcutBaseline）",
                              value=gap_value, n=gap_n))

    # Parse errors: an adapter that cannot emit JSON is unusable whatever else it scores.
    worst = 0.0
    for report in reports.values():
        for group in (report.get("metrics") or {}).values():
            worst = max(worst, float(group.get("parseErrorRate", 0.0)))
    criteria.append(Criterion("parse_error", "最差 split 解析错误率", "all", "all", "parseErrorRate", 0.02,
                              "无法产出 JSON 的模型不可用，与分数无关", value=worst, lower_is_better=True))

    context = {"reports": reports, "preds_rows": len(preds)}
    return criteria, notes, context


def print_comparison(primary: Path, reference: Path, primary_tag: str, reference_tag: str) -> str:
    """与上一版并列打出每个 split×group×metric，并返回同一份文本供落盘。

    为什么要做成程序化的一步：P3 的验收不是"v4 达标了"，而是"**v4 相对 v3 变了什么**"。
    手工对比两份 report.json 既费事又容易只挑对自己有利的那几行看，而 v4 恰恰是拿
    step 层的能力去换"训练分布与生产一致"——降了多少必须一眼看到。

    返回值不是顺手加的：这份对照表是 P3 明文要求的交付物，而 `experiments/rdmd_runs/`
    整个目录在 .gitignore 里，只打印不落盘就等于又造一份查不到的临时证据（v4 那张表
    此前就只活在 %TEMP% 的一个日志里）。落盘一份在评测目录，正本再写进受版本控制的报告。
    """
    lines: list[str] = []

    def emit(text: str = "") -> None:
        lines.append(text)

    left = load_json(primary) or {}
    right = load_json(reference) or {}
    if not right:
        emit(f"\n(no reference acceptance at {reference}; nothing to compare against)")
        text = "\n".join(lines)
        print(text)
        return text
    emit(f"\n=== {primary_tag} vs {reference_tag} ===")
    emit(f"{'criterion':34s} {reference_tag:>12s} {primary_tag:>12s} {'delta':>9s}")
    emit("-" * 72)
    ref = {item["key"]: item for item in right.get("criteria") or []}
    left_keys = set()
    new_rows = []
    for item in left.get("criteria") or []:
        left_keys.add(item["key"])
        before = ref.get(item["key"], {}).get("value")
        after = item.get("value")
        if before is None or after is None:
            # 三种 n/a 要分开说，否则读者分不清"这一项没测到"和"基线里根本没有这一项"。
            if before is None and after is None:
                delta = "both n/a"
            elif before is None:
                delta = "new"
            else:
                delta = "not scored"
        else:
            delta = f"{after - before:+.4f}"
        before_text = "n/a" if before is None else f"{before:.4f}"
        after_text = "n/a" if after is None else f"{after:.4f}"
        emit(f"{item['label']:34s} {before_text:>12s} {after_text:>12s} {delta:>9s}")
        if before is None and after is not None:
            new_rows.append(item["key"])
    for key in ref:
        if key not in left_keys:
            emit(f"{ref[key]['label']:34s} {ref[key]['value']:>12.4f} {'(gone)':>12s} {'':>9s}")

    if new_rows:
        emit(f"\n{', '.join(new_rows)} 在 {reference_tag} 里没有对应项，不是漏测：")
        emit("  step_layer_node —— v3 的 step 节点还带着富文本（artifact/output/summary），"
             "量的是另一件事；")
        emit("  status_shortcut —— `status` 在 v3 的 prompt 里根本不存在，两侧无从对比。")
        emit("  这两项正是 v4 的全部改动，所以它们只有 v4 列，且必须看绝对值是否达标。")
    emit("\n注意：两列的 corpus 版本不同（v3 vs v4），`primary_derived_only` 的分母"
         "（无原因字段子集）不是同一批行，逐行对照只能看量级，不能当等号读。")
    text = "\n".join(lines)
    print(text)
    return text



def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-tag", default="qlora-v3")
    parser.add_argument("--eval-dir", default="")
    parser.add_argument("--sft-dir", default=str(DEFAULT_SFT))
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA),
                        help="raw cases (with node `kind`). Required by the v4 step-layer and "
                             "status-shortcut criteria; the SFT prompt deliberately hides `kind`.")
    parser.add_argument("--json-out", default="")
    parser.add_argument("--compare-tag", default="",
                        help="print a side-by-side against another run's acceptance.json "
                             "(e.g. --run-tag qlora-v4 --compare-tag qlora-v3)")
    parser.add_argument("--primary-split", default="test",
                        help="split used for the node/type criteria; default test. Use development to "
                             "read an intermediate checkpoint before the test eval exists.")
    args = parser.parse_args()

    eval_dir = Path(args.eval_dir) if args.eval_dir else ROOT / "experiments" / "rdmd_runs" / f"eval-{args.run_tag}"
    sft_dir = Path(args.sft_dir)
    criteria, notes, context = collect(eval_dir, sft_dir, args.primary_split, Path(args.data_dir))
    # 出处单独取：它不进任何一个判定项，只进记录 —— 所以放在 criteria 之后，缺了只记 note。
    provenance, provenance_notes = load_provenance(eval_dir, sft_dir)
    notes.extend(provenance_notes)

    if not context["reports"]:
        print(f"NOT_ENOUGH_DATA: no eval reports under {eval_dir}")
        for note in notes:
            print("  note:", note)
        raise SystemExit(2)

    print(f"eval dir: {eval_dir}")
    print()
    print(f"{'criterion':34s} {'n':>6s} {'value':>8s} {'need':>8s}  verdict")
    print("-" * 78)
    for criterion in criteria:
        value = "n/a" if criterion.value is None else f"{criterion.value:.4f}"
        if criterion.value is None:
            verdict = "未测到"
        else:
            verdict = "PASS" if criterion.ok else "FAIL"
        print(f"{criterion.label:34s} {criterion.n:6d} {value:>8s} {criterion.threshold:8.2f}  {verdict}")

    # 未测到与未达标要分开数：`Criterion.ok` 对 None 也返回 False，混在一起报会
    # 把同一项同时算进两种失败，还会在下面打印时对 None 做格式化。
    missing = [c for c in criteria if c.value is None]
    failed = [c for c in criteria if c.value is not None and not c.ok]
    print()
    print_provenance(provenance)
    print()
    for note in notes:
        print("note:", note)

    # A missing criterion is a failure to demonstrate, not a pass.
    verdict = "USABLE" if (not failed and not missing) else "NOT_USABLE"

    print()
    if verdict == "USABLE":
        print("VERDICT: USABLE — 达标维度全部通过。记住上限：定位维度只是打平了确定性基线 D，"
              "所以这个模型的正当性来自「不写图算法/只读文本」的部署形态，不是精度。")
    else:
        parts = []
        for criterion in failed:
            parts.append(criterion.label)
        for criterion in missing:
            parts.append(f"{criterion.label}(未测到)")
        print(f"VERDICT: NOT_USABLE — {len(failed)} 项未达标、{len(missing)} 项缺失：{'、'.join(parts)}")
        for criterion in failed:
            print(f"  - {criterion.label}: {criterion.value:.4f} < {criterion.threshold:.2f}  （{criterion.why}）")

    payload = {
        "verdict": verdict,
        "evalDir": str(eval_dir),
        "provenance": provenance,
        "criteria": [
            {"key": c.key, "label": c.label, "split": c.split, "metric": c.metric, "n": c.n,
             "value": c.value, "threshold": c.threshold, "ok": c.ok, "why": c.why}
            for c in criteria
        ],
        "notes": notes,
    }
    out = Path(args.json_out) if args.json_out else eval_dir / "acceptance.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nwrote {out}")

    if args.compare_tag:
        reference = ROOT / "experiments" / "rdmd_runs" / f"eval-{args.compare_tag}" / "acceptance.json"
        comparison = print_comparison(out, reference, args.run_tag, args.compare_tag)
        # 落盘一份在评测目录（与 acceptance.json 同处），正本仍在受版本控制的报告里。
        (out.parent / "comparison.txt").write_text(comparison + "\n", encoding="utf-8")
        print(f"\nwrote {out.parent / 'comparison.txt'}")

    raise SystemExit(0 if verdict == "USABLE" else 1)


if __name__ == "__main__":
    main()
