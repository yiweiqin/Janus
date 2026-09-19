"""Tests for rdmd_acceptance.py, including a negative control built from v2's real numbers.

The point of these tests is that the gate must be able to say NO. A verdict tool that only ever
prints USABLE is worse than nothing, so the v2 case (which is genuinely unusable) is a required test:
abstention was 0.000 there, and the gate must fail on exactly that.

自足夹具（不读 `experiments/rdmd_detective_dataset/` 下任何被 gitignore 的语料）
------------------------------------------------------------
以前这套测试读真的 `sft/test.jsonl`。那份文件在 .gitignore 里（37MB，由 generate.mjs 派生），
于是**干净 clone 上这套测试不是"少测一点"，而是整个失效** —— `write_predictions` 直接
FileNotFoundError，而任何 CI 只要跳过 python 测试就什么都看不见。

真语料还有第二个毛病：它会被重新生成。拿它当夹具，"门变红了"与"语料换了"两件事会纠缠在
一起，而这两件事的处理方式完全不同（前者改代码，后者重跑参考）。

所以夹具改成**自足**的：图、SFT 行、原始 case 都在这里现造，只依赖被测试的那份代码。
造出来的行按构造满足每一项判据的前提（见下），所以每一项的期望值都是可推导的，不是"跑一遍
把输出抄下来"。夹具与真语料的关系由 `V4_FULL_REPORT.zh-CN.md` 里的真机数字承担。
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
# 这里**刻意不**再引用 `experiments/rdmd_detective_dataset/` 下的任何路径：
# 那底下被 gitignore 的语料正是这套测试以前静默失效的原因。真语料只出现在
# `experiment:rdmd-acceptance` 那次真跑里，不在这里。

# ---------------------------------------------------------------------------
# 自足夹具
# ---------------------------------------------------------------------------
GOLD = "n2"              # 真凶恒为 n2
DRIFT_ROWS = 10          # 主 split 的 drift 行数
DERIVED_ROWS = 5         # 其中"只有派生字段可见"的行数 —— 0.5，落在 §6 的 0.473±0.05 里


def _node(node_id: str, **overrides) -> dict:
    node = {
        "id": node_id, "title": f"步骤 {node_id}", "role": "writer", "agentId": "agent_a",
        "version": "v1", "acceptance": "ok", "artifact": f"{node_id}.md", "stage": "draft",
        "inputs": "[]", "output": f"{node_id} 的输出", "summary": f"{node_id} 的摘要",
        "status": "completed",
        # 真凶所在的层：`gold_kind_map` 只认原始 case 里的这个字段（prompt 里刻意没有它，
        # 否则模型可以靠"这个节点在第几层"作弊）。
        "kind": "agent_step" if node_id == GOLD else "agent_task",
    }
    node.update(overrides)
    return node


def _graph(**overrides) -> dict:
    """一条链 n1 -> n2 -> n3。真凶 n2 与其下游 n3 都有改动，于是级联根唯一。

    为什么真凶不是"编号最小的改动节点"：`status_shortcut_score` 那条捷径会挑
    (状态最坏, 编号最小) 的节点。这里让 n3 的状态最坏（cancelled）而真凶是 n2，
    捷径就会**指错**（top1 = 0），于是"模型 − 捷径"的差是 1.0 而不是 0 —— 
    一个恒等于 0 的差会让 `status_shortcut` 这项判据在夹具上静默失效。
    """
    return {
        "nodes": [_node(node_id, **overrides.get(node_id, {})) for node_id in ("n1", "n2", "n3")],
        "edges": [{"from": "n1", "to": "n2"}, {"from": "n2", "to": "n3"}],
    }


def _case(index: int, kind: str) -> tuple[dict, dict]:
    """返回 (sft 行, 原始 case 行)。`kind` ∈ {derived, cause, no_drift}。"""
    row_id = f"fixture_{kind}_{index:02d}"
    star = _graph()
    if kind == "no_drift":
        prime = _graph()
        completion = {"status": "no_drift", "nodeId": "", "type": ""}
        changed: list[str] = []
        label = {"status": "no_drift", "injected_node": "", "injected_type": ""}
    else:
        # 下游 n3 也改一个**被比较的字段**，它才进 `changed_nodes`；
        # 同时把两个节点的 status 都改掉，让 status 捷径有东西可挑（且挑错）。
        downstream = {"n3": {"output": f"n3 的部分输出 {index}", "status": "cancelled"},
                      "n2": {"status": "running"}}
        if kind == "derived":
            # 只动 artifact/output：四个原因字段两侧完全相同 → 这一行落进 derived-only 子集。
            prime = _graph(**{**downstream, "n2": {**downstream["n2"],
                                                   "artifact": f"n2.v2.{index}.md",
                                                   "output": f"n2 的输出 v2 {index}"}})
            injected_type = "local_replan"
        else:
            # 动一个原因字段 → 这一行落在"原因字段可见"那一档。
            prime = _graph(**{**downstream, "n2": {**downstream["n2"], "agentId": "agent_b"}})
            injected_type = "wrong_agent"
        completion = {"status": "drift", "nodeId": GOLD, "type": injected_type}
        changed = ["n2", "n3"]
        label = {"status": "drift", "injected_node": GOLD, "injected_type": injected_type}

    sft_row = {
        "id": row_id,
        # `parse_prompt_input` 从 `INPUT=` 之后 `raw_decode`，所以 prompt 必须以它收尾。
        "prompt": "SYSTEM=夹具\nINPUT=" + json.dumps({"G_star": star, "G_prime": prime}, ensure_ascii=False),
        "completion": json.dumps(completion, ensure_ascii=False),
    }
    data_row = {
        "id": row_id, "label": label, "G_star": star, "G_prime": prime,
        "changed_node_ids": changed, "tag": {"kind": kind, "scale": 3},
    }
    return sft_row, data_row


@contextmanager
def fixture():
    """造一份自足的 sft/ + data/，退出时删掉。"""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        sft_dir, data_dir = root / "sft", root / "data"
        sft_dir.mkdir(parents=True)
        data_dir.mkdir(parents=True)
        rows = [_case(index, "derived" if index < DERIVED_ROWS else "cause")
                for index in range(DRIFT_ROWS)]
        rows.append(_case(DRIFT_ROWS, "no_drift"))
        (sft_dir / "test.jsonl").write_text(
            "".join(json.dumps(row[0], ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        # 只写 test：`read_jsonl` 对不存在的文件返回 []，train/development 留空正是"没有"的意思。
        (data_dir / "test.jsonl").write_text(
            "".join(json.dumps(row[1], ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        yield sft_dir, data_dir


def write_reports(eval_dir: Path, *, node: float, type_hit: float, abstain: float, no_drift: float,
                  parse_error: float = 0.0) -> None:
    def report(split: str, metrics: dict) -> None:
        (eval_dir / f"{split}.report.json").write_text(
            json.dumps({"status": "scored", "split": split, "n": 0, "metrics": metrics}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    report("test", {
        "drift": {"n": 1427, "statusHit": 1.0, "nodeHit": node, "typeHit": type_hit, "unknownRate": 0.0, "parseErrorRate": parse_error},
        "no_drift": {"n": 111, "statusHit": 1.0, "unknownRate": 0.0, "parseErrorRate": parse_error},
        "UNKNOWN": {"n": 226, "statusHit": 0.0, "unknownRate": 0.0, "parseErrorRate": parse_error},
    })
    report("eval_unknown", {"UNKNOWN": {"n": 226, "statusHit": abstain, "nodeHit": 0.0, "typeHit": 0.0,
                                        "unknownRate": abstain, "parseErrorRate": parse_error}})
    report("eval_no_drift", {"no_drift": {"n": 111, "statusHit": no_drift, "unknownRate": 1 - no_drift,
                                          "parseErrorRate": parse_error}})


def write_predictions(eval_dir: Path, sft_dir: Path, *, drop_fraction: float = 0.0) -> None:
    """把 gold 当预测喂进去：满分模型，可选地在前缀上退化。

    退化只能落在**前缀**上，这样 `drop_fraction=0.30` 恰好打掉前几行；
    夹具的行是"先 derived 后 cause"排的，所以这一刀打的是 derived-only 子集 —— 
    也就是 case 3 想验的那件事（总定位还好，但真正考推理的那一档塌了）。
    """
    rows = [json.loads(line) for line in (sft_dir / "test.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    drift = [row for row in rows if json.loads(row["completion"])["status"] == "drift"]
    cut = int(len(drift) * drop_fraction)
    broken = {row["id"] for row in drift[:cut]}
    out = []
    for row in rows:
        gold = json.loads(row["completion"])
        if row["id"] in broken:
            payload = dict(gold, nodeId="n_wrong", type="wrong_agent")
            out.append({"id": row["id"], "prediction": json.dumps(payload, ensure_ascii=False)})
        else:
            out.append({"id": row["id"], "prediction": json.dumps(gold, ensure_ascii=False)})
    (eval_dir / "merged.predictions.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in out), encoding="utf-8")


def run(eval_dir: Path, sft_dir: Path, data_dir: Path) -> tuple[int, str]:
    """跑真门（子进程），把 sft/data 指到夹具上 —— 与 `experiment:rdmd-acceptance` 同一个入口。"""
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / "rdmd_acceptance.py"), "--eval-dir", str(eval_dir),
         "--sft-dir", str(sft_dir), "--data-dir", str(data_dir)],
        capture_output=True, text=True, encoding="utf-8",
    )
    return result.returncode, (result.stdout or "") + (result.stderr or "")


def read_acceptance(eval_dir: Path) -> dict:
    return json.loads((eval_dir / "acceptance.json").read_text(encoding="utf-8-sig"))


def write_manifest(eval_dir: Path, sft_dir: Path, *, split: str = "test", hash_matches: bool = True) -> None:
    """造一份发布时该有的 eval_manifest.json。

    `hash_matches=False` 模拟"评测读的标签和本地这份不是同一批" —— 也就是"出处对不上"。
    """
    source = sft_dir / f"{split}.jsonl"
    # split 不存在时给个占位哈希：case 8 要的正是"本地没有这个文件"这条路径。
    real = hashlib.sha256(source.read_bytes()).hexdigest() if source.is_file() else "c" * 64
    (eval_dir / "eval_manifest.json").write_text(json.dumps({
        "runTag": "qlora-v4",
        "source": "launch",
        "adapter": {"path": "/box/adapter", "sha256": "a" * 64, "bytes": 12345,
                    "baseModel": "/root/autodl-tmp/models/Qwen3-8B"},
        "sft": {"schemaVersion": "rdmd_detective_sft_v4", "sourceVersion": "rdmd_detective_dataset_v4",
                "splits": {split: {"n": 1665, "sha256": real if hash_matches else "0" * 64}}},
        "evaluator": {"path": "scripts/eval_rdmd_qlora.py", "sha256": "b" * 64},
    }, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    failures: list[str] = []

    # 夹具只建一次、全程共用：它同时是"语料"和"要被指过去的 sft/data"，每次重建会让
    # 各 case 之间出现"其实不是同一批语料"的微妙差别。
    with fixture() as (sft_dir, data_dir):
        failures.extend(run_cases(sft_dir, data_dir))

    print()
    if failures:
        for failure in failures:
            print("FAIL:", failure)
        raise SystemExit(1)
    print("ALL ACCEPTANCE TESTS PASSED")


def run_cases(sft_dir: Path, data_dir: Path) -> list[str]:
    failures: list[str] = []

    # 1. v2's real metrics: perfect localisation on shortcuted data, zero abstention, nothing else wrong.
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=1.0, type_hit=0.9971, abstain=0.0, no_drift=1.0)
        write_predictions(eval_dir, sft_dir)
        code, text = run(eval_dir, sft_dir, data_dir)
        print("== case 1: v2 numbers ==")
        print(text)
        if code != 1 or "NOT_USABLE" not in text or "UNKNOWN 弃权率" not in text:
            failures.append("v2 case should be NOT_USABLE and blame abstention")

    # 2. a healthy model: everything at or above threshold.
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0)
        write_predictions(eval_dir, sft_dir)
        code, text = run(eval_dir, sft_dir, data_dir)
        print("== case 2: healthy model ==")
        print(text)
        if code != 0 or "USABLE" not in text:
            failures.append("healthy model should be USABLE")
        if "may have drifted" in text:
            failures.append("derived-only subset definition should match the published baseline")
        if read_acceptance(eval_dir).get("provenance") is not None:
            failures.append("a run with no manifest must record provenance as null, not fabricate one")
        if "eval_manifest.json 缺失" not in text:
            failures.append("a missing manifest must be stated in the notes")

    # 3. good aggregate localisation but the reasoning subset fails: the gate must catch it.
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0)
        write_predictions(eval_dir, sft_dir, drop_fraction=0.30)
        code, text = run(eval_dir, sft_dir, data_dir)
        print("== case 3: reasoning subset degraded ==")
        print(text)
        if code != 1 or "test 无原因字段子集定位" not in text:
            failures.append("degraded derived-only subset should be caught")

    # 4. parse errors make a model unusable even with good scores.
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0, parse_error=0.10)
        write_predictions(eval_dir, sft_dir)
        code, text = run(eval_dir, sft_dir, data_dir)
        print("== case 4: parse errors ==")
        print(text)
        if code != 1 or "解析错误率" not in text:
            failures.append("parse error guard should fail the verdict")

    # 5. no data yet must not be reported as usable.
    with tempfile.TemporaryDirectory() as tmp:
        code, text = run(Path(tmp), sft_dir, data_dir)
        print("== case 5: no reports ==")
        print(text)
        if code != 2 or "NOT_ENOUGH_DATA" not in text:
            failures.append("missing reports should exit 2 with NOT_ENOUGH_DATA")

    # 5b. 语料缺失（干净 clone 上真语料不在）必须表现为"未测到"，不能变成"通过"。
    #     这是本轮新加的一条：`read_jsonl` 对不存在的文件返回 []，于是少一批语料原来会让
    #     逐行判据静默变成 n/a —— 而 n/a 会让判定变成 NOT_USABLE，方向是对的；
    #     但**覆盖度**那条路径不同：它会报"predictions cover only 0/0 (0.0%)"这种
    #     读起来像"模型不行"的话。所以要断言：语料缺失时，说的话是"缺语料"。
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0)
        write_predictions(eval_dir, sft_dir)
        empty_sft = Path(tmp) / "empty-sft"
        empty_sft.mkdir()
        code, text = run(eval_dir, empty_sft, data_dir)
        print("== case 5b: 语料缺失 ==")
        print(text)
        if code != 1:
            failures.append("空语料下逐行判据必须是未测到 → NOT_USABLE（未测到不是通过）")
        if "no usable merged.predictions.jsonl" not in text and "step-layer criterion not scored" not in text:
            failures.append("空语料必须被说成「没测到」而不是「模型不行」")

    # 6. provenance 对得上：结论要能说出自己判的是哪份权重、哪批标签。
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0)
        write_predictions(eval_dir, sft_dir)
        write_manifest(eval_dir, sft_dir)
        code, text = run(eval_dir, sft_dir, data_dir)
        print("== case 6: provenance 一致 ==")
        print(text)
        payload = read_acceptance(eval_dir)
        provenance = payload.get("provenance") or {}
        if code != 0 or "USABLE" not in text:
            failures.append("recording provenance must not disturb a healthy verdict")
        if provenance.get("source") != "launch" or not (provenance.get("adapter") or {}).get("sha256"):
            failures.append("acceptance.json must carry the adapter identity")
        if (provenance.get("labelIntegrity") or {}).get("test", {}).get("match") is not True:
            failures.append("a matching label hash should be recorded as match=true")
        if provenance.get("labelIntegrityOk") is not True:
            failures.append("labelIntegrityOk should be true when every split matches")

    # 7. provenance 对不上：要吵，但**不能**翻判定 —— 那道门是覆盖度守卫的活。
    #    在这里加门会引入一类新的假失败：本地重新生成过语料就会亮红，哪怕内容一字不差。
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0)
        write_predictions(eval_dir, sft_dir)
        write_manifest(eval_dir, sft_dir, hash_matches=False)
        code, text = run(eval_dir, sft_dir, data_dir)
        print("== case 7: provenance 不一致 ==")
        print(text)
        provenance = read_acceptance(eval_dir).get("provenance") or {}
        if code != 0 or "USABLE" not in text:
            failures.append("a label mismatch must be reported, not silently turned into a verdict flip")
        if provenance.get("labelIntegrityOk") is not False:
            failures.append("labelIntegrityOk should be false on a confirmed mismatch")
        if "标签哈希对不上" not in text:
            failures.append("a confirmed label mismatch must be loud")

    # 8. 本地没有这个 split 的文件 = 无从核对，不是不一致。两者混报会把"没查"说成"查出错"。
    with tempfile.TemporaryDirectory() as tmp:
        eval_dir = Path(tmp)
        write_reports(eval_dir, node=0.97, type_hit=0.65, abstain=0.88, no_drift=1.0)
        write_predictions(eval_dir, sft_dir)
        write_manifest(eval_dir, sft_dir, split="a_split_we_do_not_have")
        code, text = run(eval_dir, sft_dir, data_dir)
        print("== case 8: 无从核对 ==")
        print(text)
        provenance = read_acceptance(eval_dir).get("provenance") or {}
        row = (provenance.get("labelIntegrity") or {}).get("a_split_we_do_not_have", {})
        if row.get("match") is not None:
            failures.append("a split we cannot see locally must be unverifiable, not a mismatch")
        if provenance.get("labelIntegrityOk") is not True:
            failures.append("unverifiable is not the same as mismatched")
        if "标签哈希对不上" in text:
            failures.append("unverifiable must not print the mismatch warning")

    return failures


if __name__ == "__main__":
    main()
