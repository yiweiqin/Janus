"""Score the OOD probe: deterministic baseline (rules A-E) vs the trained model.

Run twice:
  1. without --verdicts -> baseline only (no GPU needed)
  2. with    --verdicts -> adds the model columns

The baseline is NOT re-implemented here: rules A-E are imported from
scripts/rdmd_trivial_baseline.py, which is the same code that produced the v3 baseline table. Two
copies of a baseline definition drift apart, and a mis-stated baseline silently rewrites the
conclusion.

Grouping by *scale* is the deployment-relevant cut ("how big a plan can I hand it?"); grouping by
*shape* answers "does an unfamiliar topology break it?". Both sides are measured on identical rows,
so "baseline holds but model drops" is the pattern that proves a generalisation gap, while "both
drop" means the probe got hard for the task definition.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
LABELS = HERE / "data" / "ood_labels.json"
CASES = HERE / "data" / "ood_cases.jsonl"
SFT = HERE / "sft" / "ood.jsonl"


def load_baseline_module():
    path = REPO / "scripts" / "rdmd_trivial_baseline.py"
    spec = importlib.util.spec_from_file_location("_rdmd_trivial_baseline", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def baseline_verdict(module, sft_row: dict) -> dict:
    """Rule E expressed in the same shape as a model verdict, so both can be scored identically."""
    result = module.evaluate_row(sft_row)
    if result.get("no_drift"):
        return {"status": "no_drift", "nodeId": "", "type": ""}
    rule_e = result.get("ruleE") or {}
    return {
        "status": rule_e.get("status", "UNKNOWN"),
        "nodeId": rule_e.get("nodeId", ""),
        "type": rule_e.get("type", ""),
    }


def check_prompt_contract(sft_path: Path, cases_path: Path) -> list[str]:
    """The byte-exact guarantee, extended to OOD inputs.

    The shipped `build_prompt` is verified against the training rows; OOD inputs are far longer and
    contain repeated titles, i.e. exactly the shapes that would expose a normalisation difference.
    If the delivered package reproduces these prompts byte-for-byte, a failure on them is a genuine
    model result rather than an input-plumbing artefact.
    """
    sys.path.insert(0, str(HERE / "deploy"))
    import rdmd_detective as rd

    prompts = {row["id"]: row["prompt"] for row in read_jsonl(sft_path)}
    mismatches = []
    for case in read_jsonl(cases_path):
        prompt = prompts.get(case["id"])
        if prompt is None:
            continue
        if rd.build_prompt(case["G_star"], case["G_prime"]) != prompt:
            mismatches.append(case["id"])
    return mismatches


def pct(hit: int, total: int) -> str:
    return "  -  " if not total else f"{hit / total:.3f}"


# ---------------------------------------------------------------------------
# 门：新鲜跑出来的**基线列**必须和受版本控制的参考逐位一致
# ---------------------------------------------------------------------------
#
# 为什么门只比 `base_*`：`model_*` 需要 GPU 与那份权重，在本地（和干净 clone）上
# 不可能复现；把由模型决定的数字放进本地的门，门就只能被跳过，或者更糟 —— 被伪造。
# 反过来，基线是**纯函数**（rules A–E，见 scripts/rdmd_trivial_baseline.py）：
# 同样的语料必须给出同样的计数，一个都不能差。所以这里用**整数逐位相等**，
# 而不是"误差 1e-6"这种 —— 计数本来就没有浮点误差可言，给容差只会让门更容易放过漂移。
#
# 参考不是手写的，而是 `--write-reference` 从一次真实跑里导出的，并且**钉住语料的 sha256**。
# 于是"参考描述的是哪批字节"不再靠上下文暗示：换一批语料，参考里的哈希就对不上。
#
# 反面：为什么这个门值得存在。`data/*_summary.json` 是 §12–13 那些结论的**唯一落脚点**
# （"基线 node 1.000 / type 0.527"就是从这儿来的），而在此之前它们只被手工命令写过一次，
# 之后再没有任何东西核对过。改一行 `NODE_FIELDS` 或 `CAUSE_FIELDS` 就能让那张表变样，
# 而报告里的数字照旧。这个门第一次跑就红了 23 + 20 处 —— 见 §14。
GATE_COUNTERS = ("n", "drift_n", "base_node", "base_type", "base_status", "abstain_n", "base_abstain")
GATE_SECTIONS = ("byScale", "byKind", "byDifficulty")
REFERENCE_VERSION = 1


def load_reference(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def describe_file(path: Path) -> dict:
    return {"sha256": sha256_file(path, full=True), "bytes": path.stat().st_size if path.is_file() else 0}


def corpus_fingerprint(labels_path: Path, sft_path: Path, cases_path: Path) -> dict:
    return {
        "labels": describe_file(labels_path),
        "sft": describe_file(sft_path),
        "cases": describe_file(cases_path),
    }


def label_disagreements(rows: list[dict]) -> list[tuple[str, str, str]]:
    """基线说的和标签说的**不一致**的行 —— `(id, 标签, 基线)`。

    这才是这批语料真正的性质，比分组计数更本质：分组计数只是它的外在表现。
    把它钉进参考，"基线在这个探针上和标签一致"就从一句印象变成一条会被检查的不变量；
    将来某次探针改动多出一行不一致，门会指名道姓地说出来，而不是让某个计数悄悄 -1。
    """
    out = []
    for row in rows:
        got = (row.get("baseline") or {}).get("status") or ""
        if got != row["status"]:
            out.append((str(row["id"]), str(row["status"]), got))
    return out


def build_reference(probe: str, fingerprint: dict, fresh: dict, disagreements: list) -> dict:
    return {
        "version": REFERENCE_VERSION,
        "probe": probe,
        "note": ("基线（rules A–E）的计数参考。由 score_ood.py --write-reference 从一次真实跑导出；"
                 "`model_*` 刻意不在里面（那需要 GPU 与具体权重）。改这个文件等于改门的判据，"
                 "所以它必须来自一次真实跑，而不是手改。"),
        "corpus": fingerprint,
        "counters": list(GATE_COUNTERS),
        "sections": list(GATE_SECTIONS),
        "baseline": fresh,
        "labelDisagreements": [{"id": row_id, "label": label, "baseline": got}
                               for row_id, label, got in disagreements],
    }


def gate_compare(fresh: dict, reference: dict) -> list[str]:
    """逐组逐计数比对，返回差异清单（空 = 过）。

    `model_*` / `invalid` / `errors` **刻意不比**：前两个由模型决定，`errors` 里装的是
    "这份 verdict 为什么无效"的运行时原因 —— 它们不是基线的性质，比它们等于把 GPU
    的随机性接进本地门。漏掉一条差异的代价是不可见，所以分组的增删也要报。
    """
    diffs: list[str] = []
    expected = reference.get("baseline") or {}
    for section in reference.get("sections") or GATE_SECTIONS:
        ref_groups = expected.get(section) or {}
        new_groups = fresh.get(section) or {}
        if not ref_groups:
            # 参考里没有这一节 → 我们不比它。这条**不是**通过，所以要留痕：
            # 否则"参考文件被换成一个空壳"会表现为"门全过"。
            diffs.append(f"{section}: 参考里没有这一节，无法比对（参考文件可能被替换或写坏过）")
            continue
        for key in sorted(set(ref_groups) - set(new_groups)):
            diffs.append(f"{section}/{key}: 这一组在新跑里消失了")
        for key in sorted(set(new_groups) - set(ref_groups)):
            diffs.append(f"{section}/{key}: 新跑多出一组（参考里没有）")
        for key in sorted(set(ref_groups) & set(new_groups)):
            for counter in reference.get("counters") or GATE_COUNTERS:
                want = ref_groups[key].get(counter)
                if want is None:
                    continue
                got = new_groups[key].get(counter)
                if got is None:
                    diffs.append(f"{section}/{key}.{counter}: 新跑缺少这个量")
                elif int(want) != int(got):
                    diffs.append(f"{section}/{key}.{counter}: {got} != 参考 {want}")
    return diffs


def gate_compare_corpus(fingerprint: dict, reference: dict) -> list[str]:
    """参考描述的是不是**这批字节**。哈希对不上时，比数字没有意义（两边在说不同的事）。"""
    diffs = []
    for name, actual in fingerprint.items():
        want = (reference.get("corpus") or {}).get(name) or {}
        if not want.get("sha256"):
            diffs.append(f"corpus/{name}: 参考里没记哈希 —— 无法确认它描述的是这批字节")
        elif want["sha256"] != actual["sha256"]:
            diffs.append(f"corpus/{name}: 实际 {actual['sha256'][:16]} != 参考 {str(want['sha256'])[:16]}")
    return diffs


def gate_compare_disagreements(disagreements: list, reference: dict) -> list[str]:
    """与标签不一致的行，必须**恰好**是参考里记下的那几行。

    这一条把"基线在这个探针上与标签一致"变成不变量。少了任何一行同样要报：
    一行不一致如果自己消失了，说明语料或规则被改过 —— 那也是要看见的事，不是好消息。
    """
    got = {row[0] for row in disagreements}
    want = {str(entry.get("id")) for entry in (reference.get("labelDisagreements") or [])}
    diffs = []
    for row_id in sorted(got - want):
        detail = next((row for row in disagreements if row[0] == row_id), ("", "", ""))
        diffs.append(f"与标签不一致的行多出 {row_id}（标签 {detail[1]}，基线 {detail[2]}）")
    for row_id in sorted(want - got):
        diffs.append(f"参考里记着与标签不一致的 {row_id} 现在一致了（语料或规则被改过）")
    return diffs


def perturb_reference(reference: dict) -> tuple[dict, str]:
    """负对照用的扰动：改掉**一个**基线计数，返回 (被改过的参考, 被改的位置说明)。

    改"参考"而不是"新跑"，是为了不碰磁盘上的任何产物；门要证明的是它真的在比，
    改哪一边都能证明，改参考的副作用最小。挑第一组里第一个非零的基线计数，
    保证扰动**一定**落在会被比到的量上。
    """
    import copy

    mutated = copy.deepcopy(reference)
    for section in mutated.get("sections") or GATE_SECTIONS:
        for key, stats in (mutated.get("baseline") or {}).get(section, {}).items():
            for counter in mutated.get("counters") or GATE_COUNTERS:
                value = stats.get(counter)
                if isinstance(value, int) and value > 0:
                    stats[counter] = value + 1
                    return mutated, f"{section}/{key}.{counter} {value} -> {value + 1}"
    raise SystemExit("负对照失败：参考里找不到任何可扰动的基线计数（参考文件是空的？）")


def group_stats(rows: list[dict], verdicts: dict[str, dict]) -> dict:
    stats = {
        "n": len(rows),
        "drift_n": 0,
        "base_node": 0, "model_node": 0,
        "base_type": 0, "model_type": 0,
        "base_status": 0, "model_status": 0,
        "abstain_n": 0, "base_abstain": 0, "model_abstain": 0,
        "invalid": 0, "errors": [],
    }
    for row in rows:
        status = row["status"]
        base = row["baseline"]

        if status == "drift":
            stats["drift_n"] += 1
            stats["base_node"] += 1 if base["status"] == "drift" and base["nodeId"] == row["injected_node"] else 0
            stats["base_type"] += 1 if base["type"] == row["injected_type"] and row["injected_type"] else 0
        elif status == "UNKNOWN":
            stats["abstain_n"] += 1
            stats["base_abstain"] += 1 if base["status"] == "UNKNOWN" else 0
        stats["base_status"] += 1 if base["status"] == status else 0

        if not verdicts:
            continue
        entry = verdicts.get(row["id"])
        if entry is None:
            stats["invalid"] += 1
            stats["errors"].append(f"{row['id']}:missing_verdict")
            continue
        verdict = entry.get("verdict") or {}
        if not entry.get("valid"):
            stats["invalid"] += 1
            stats["errors"].append(f"{row['id']}:{','.join(entry.get('warnings') or [])}")
        if verdict.get("status") == status:
            stats["model_status"] += 1
        if status == "drift" and verdict.get("status") == "drift":
            stats["model_node"] += 1 if verdict.get("nodeId") == row["injected_node"] else 0
            stats["model_type"] += 1 if verdict.get("type") == row["injected_type"] else 0
        if status == "UNKNOWN" and verdict.get("status") == "UNKNOWN":
            stats["model_abstain"] += 1
    return stats


def render(title: str, groups: dict[str, list[dict]], verdicts: dict[str, dict], order=None) -> None:
    print(f"\n== {title} ==")
    header = (f"{'group':<24}{'n':>4}{'b_node':>8}{'m_node':>8}{'b_type':>8}{'m_type':>8}"
              f"{'b_stat':>8}{'m_stat':>8}{'b_abs':>8}{'m_abs':>8}{'bad':>5}")
    print(header)
    print("-" * len(header))
    keys = order or sorted(groups, key=lambda key: (len(key), key))
    for key in keys:
        rows = groups.get(key)
        if not rows:
            continue
        stats = group_stats(rows, verdicts)
        print(f"{key:<24}{stats['n']:>4}"
              f"{pct(stats['base_node'], stats['drift_n']):>8}{pct(stats['model_node'], stats['drift_n']):>8}"
              f"{pct(stats['base_type'], stats['drift_n']):>8}{pct(stats['model_type'], stats['drift_n']):>8}"
              f"{pct(stats['base_status'], stats['n']):>8}{pct(stats['model_status'], stats['n']):>8}"
              f"{pct(stats['base_abstain'], stats['abstain_n']):>8}"
              f"{pct(stats['model_abstain'], stats['abstain_n']):>8}{stats['invalid']:>5}")
    all_rows = [row for rows in groups.values() for row in rows]
    stats = group_stats(all_rows, verdicts)
    print("-" * len(header))
    print(f"{'ALL':<24}{stats['n']:>4}"
          f"{pct(stats['base_node'], stats['drift_n']):>8}{pct(stats['model_node'], stats['drift_n']):>8}"
          f"{pct(stats['base_type'], stats['drift_n']):>8}{pct(stats['model_type'], stats['drift_n']):>8}"
          f"{pct(stats['base_status'], stats['n']):>8}{pct(stats['model_status'], stats['n']):>8}"
          f"{pct(stats['base_abstain'], stats['abstain_n']):>8}"
          f"{pct(stats['model_abstain'], stats['abstain_n']):>8}{stats['invalid']:>5}")
    print("b_ = rule E baseline (v3: node 1.000 / type 0.527) | m_ = model")
    print("node/type over drift rows only; abs = UNKNOWN abstention; bad = invalid verdicts")
    if stats["errors"]:
        for line in stats["errors"][:5]:
            print(f"  ! {line}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verdicts", default="", help="JSONL from predict.py")
    parser.add_argument("--json-out", default="", help="write the summary as JSON")
    # The adversarial probe uses the same baseline and the same scoring, so it reuses this script
    # rather than growing a second copy of rules A-E.
    parser.add_argument("--labels", default=str(LABELS))
    parser.add_argument("--cases", default=str(CASES))
    parser.add_argument("--sft", default=str(SFT))
    # 门：把这一跑算出来的**基线列**与受版本控制的汇总逐位比。
    # 默认参考就是 ood 那份；对抗探针复用一个脚本，所以参考由调用方显式给出。
    parser.add_argument("--gate", action="store_true",
                        help="与 --reference 逐位比对基线列；不一致则 exit 1")
    parser.add_argument("--reference", default=str(HERE / "data" / "ood_baseline.json"),
                        help="受版本控制的基线参考（data/<probe>_baseline.json）")
    parser.add_argument("--probe", default="", help="写参考时记进文件的探针名（ood / adv）")
    parser.add_argument("--write-reference", action="store_true",
                        help="把这一跑的基线导出为 --reference（钉住今天的语料），然后退出")
    parser.add_argument("--selfcheck", action="store_true",
                        help="门的负对照：先证明当前这一跑**过**，再扰动参考证明它**会失败**")
    args = parser.parse_args()

    labels_path, cases_path, sft_path = Path(args.labels), Path(args.cases), Path(args.sft)

    baseline_module = load_baseline_module()
    labels = {row["id"]: row for row in json.loads(labels_path.read_text(encoding="utf-8"))}
    sft = {row["id"]: row for row in read_jsonl(sft_path)}

    rows = []
    for row_id, label in labels.items():
        sft_row = sft.get(row_id)
        if sft_row is None:
            print(f"[error] no sft row for {row_id}", file=sys.stderr)
            return 2
        rows.append({**label, "baseline": baseline_verdict(baseline_module, sft_row)})

    verdicts = {}
    if args.verdicts:
        for row in read_jsonl(Path(args.verdicts)):
            verdicts[row["id"]] = row
        print(f"loaded {len(verdicts)} verdicts")

    mismatches = check_prompt_contract(sft_path, cases_path)
    print(f"prompt byte-exact vs delivered package: "
          f"{'checked, 0 mismatches' if not mismatches else 'MISMATCH ' + str(mismatches[:3])}")

    has_contract_split = any("inContract" in row for row in rows)
    if has_contract_split:
        in_contract = [row for row in rows if row["inContract"]]
        print(f"rows: {len(rows)} total, {len(in_contract)} in-contract, "
              f"{len(rows) - len(in_contract)} out-of-contract")
    else:
        print(f"rows: {len(rows)} total")

    by_scale: dict[str, list[dict]] = {}
    by_kind: dict[str, list[dict]] = {}
    by_difficulty: dict[str, list[dict]] = {}
    for row in rows:
        by_scale.setdefault(str(row["scale"]), []).append(row)
        by_kind.setdefault(row["kind"], []).append(row)
        if row["status"] != "drift":
            difficulty = row["status"]
        elif row.get("derivedOnly"):
            difficulty = "drift: derived-only"
        else:
            difficulty = "drift: cause field"
        by_difficulty.setdefault(difficulty, []).append(row)

    render("by scale (nodes in G_star)", by_scale, verdicts)
    render("by kind", by_kind, verdicts)
    render("by difficulty (what is visible on the culprit)", by_difficulty, verdicts,
           order=["drift: cause field", "drift: derived-only", "no_drift", "UNKNOWN"])
    if has_contract_split:
        render("in-contract only (legal task instances)",
               {"in-contract": [row for row in rows if row["inContract"]]}, verdicts)
        render("out-of-contract probes (schema violation)",
               {"out": [row for row in rows if not row["inContract"]]}, verdicts)

    if args.json_out:
        Path(args.json_out).write_text(json.dumps({
            "byScale": {key: group_stats(value, verdicts) for key, value in by_scale.items()},
            "byKind": {key: group_stats(value, verdicts) for key, value in by_kind.items()},
            "byDifficulty": {key: group_stats(value, verdicts) for key, value in by_difficulty.items()},
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.gate or args.selfcheck:
        return run_gate(args, rows, by_scale, by_kind, by_difficulty, verdicts)
    return 0


def run_gate(args, rows: list[dict], by_scale, by_kind, by_difficulty, verdicts) -> int:
    """门、参考的落盘、以及门的负对照。

    先说清这一跑判的是什么、判的是哪些字节：把语料与标签的 sha256 打出来。
    没有这一段，"过"就只是一个字 —— 换一批语料照样可以"过"。
    """
    fresh = {
        "byScale": {key: group_stats(value, verdicts) for key, value in by_scale.items()},
        "byKind": {key: group_stats(value, verdicts) for key, value in by_kind.items()},
        "byDifficulty": {key: group_stats(value, verdicts) for key, value in by_difficulty.items()},
    }
    labels_path, cases_path, sft_path = Path(args.labels), Path(args.cases), Path(args.sft)
    for name, path in (("labels", labels_path), ("cases", cases_path), ("sft", sft_path)):
        if not path.is_file():
            print(f"[gate] 缺 {name}: {path}", file=sys.stderr)
            print("[gate] 探针语料不进版本库（体积），但它**是可复现的**："
                  "先跑 node make_ood.mjs / node make_adversarial.mjs。未测到不是通过。", file=sys.stderr)
            return 3
    fingerprint = corpus_fingerprint(labels_path, sft_path, cases_path)
    disagreements = label_disagreements(rows)

    print("\n== 基线门 ==")
    print(f"探针: {args.probe or '(未命名)'}   参考: {args.reference}")
    for name, info in fingerprint.items():
        print(f"  {name:6s} {info['sha256'][:16]}  {info['bytes']} bytes")
    print(f"标签与基线不一致的行: {len(disagreements)}")
    for row_id, label, got in disagreements:
        print(f"  - {row_id}: 标签 {label} / 基线 {got}")

    if args.write_reference:
        reference_path = Path(args.reference)
        reference_path.parent.mkdir(parents=True, exist_ok=True)
        payload = build_reference(args.probe, fingerprint, fresh, disagreements)
        reference_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n已写出参考: {reference_path}")
        print("注意：这只是把**今天的**基线钉住（回归门），不是「今天的数字是对的」的证明。"
              "要改判据请改 rules A–E，然后重新导出 —— 手改这个文件等于把手改的判据当成实测。")
        return 0

    reference_path = Path(args.reference)
    if not reference_path.is_file():
        print(f"[gate] 参考文件不存在：{reference_path} —— 未测到，不是通过", file=sys.stderr)
        print("[gate] 首次运行请加 --write-reference 从一次真实跑导出。", file=sys.stderr)
        return 3

    reference = load_reference(reference_path)
    if int(reference.get("version") or 0) != REFERENCE_VERSION:
        print(f"[gate] 参考版本 {reference.get('version')} != 期望 {REFERENCE_VERSION} —— 无法比对",
              file=sys.stderr)
        return 3

    diffs = gate_compare_corpus(fingerprint, reference) \
        + gate_compare(fresh, reference) \
        + gate_compare_disagreements(disagreements, reference)
    print(f"比对的量: {' '.join(reference.get('counters') or GATE_COUNTERS)}"
          "（`model_*` 由 GPU 与权重决定，刻意不在门里）")

    if args.selfcheck:
        # 负对照分两步，缺一不可：
        #   (1) 当前这一跑必须**真的过** —— 否则"扰动后失败"毫无信息量
        #       （一个恒失败的门当然会失败）。
        #   (2) 扰动一个计数后必须**真的失败**，且差异清单要指到被改的那个量。
        # 只做 (2) 的门可能是"永远报错"，只做 (1) 的门可能是"永远通过"。
        if diffs:
            print(f"[selfcheck] 当前这一跑本身就不一致（{len(diffs)} 处）—— 负对照无从谈起", file=sys.stderr)
            for line in diffs[:5]:
                print(f"  ! {line}", file=sys.stderr)
            return 1
        print("[selfcheck] 第 1 步：当前语料与参考逐位一致（否则负对照无意义）")

        mutated, where = perturb_reference(reference)
        mutated_diffs = gate_compare(fresh, mutated)
        if not mutated_diffs:
            print("[selfcheck] 负对照失败：把一个计数改掉之后门仍然说「过」—— 这个门是假的", file=sys.stderr)
            return 1
        needle = where.split()[0]
        if not any(needle in line for line in mutated_diffs):
            print(f"[selfcheck] 负对照失败：门报了 {len(mutated_diffs)} 处差异，但没有一处指到被改的 {needle}",
                  file=sys.stderr)
            for line in mutated_diffs[:5]:
                print(f"  ! {line}", file=sys.stderr)
            return 1
        print(f"[selfcheck] 第 2 步：扰动 {where} 之后门报出 {len(mutated_diffs)} 处差异，并指到了该处")
        print("[selfcheck] OK —— 这个门既会过也会不过，不是恒定输出")
        return 0

    if diffs:
        print(f"\nGATE: FAIL —— {len(diffs)} 处与参考不一致", file=sys.stderr)
        for line in diffs[:40]:
            print(f"  ! {line}", file=sys.stderr)
        if len(diffs) > 40:
            print(f"  ... 还有 {len(diffs) - 40} 处", file=sys.stderr)
        print("\n基线是纯函数：同样的语料必须给出同样的计数。差异意味着 rules A–E 的定义、"
              "语料的生成、或评分脚本至少有一处变了 —— 而 §12–13 的结论还挂在旧数字上。",
              file=sys.stderr)
        return 1

    print(f"\nGATE: PASS —— {len(rows)} 行，{len(fresh['byKind'])} 个 kind 组与参考逐位一致，"
          f"{len(disagreements)} 行与标签不一致（与参考记下的完全一致）")
    return 0


def sha256_file(path: Path, full: bool = False) -> str:
    import hashlib

    if not path.is_file():
        return "0" * 64 if full else "缺失".ljust(16)
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest() if full else digest.hexdigest()[:16]


if __name__ == "__main__":
    sys.exit(main())
