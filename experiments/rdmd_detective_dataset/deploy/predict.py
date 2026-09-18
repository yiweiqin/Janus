"""RDMD 反向侦探：独立推理入口。

用法（GPU 机器上）：

    python predict.py --input cases.jsonl --adapter /path/to/adapter \
        --model /path/to/Qwen3-8B --output verdicts.jsonl

没有 GPU 时可以先验契约（只拼 prompt、不加载模型）：

    python predict.py --input cases.jsonl --dry-run

契约的权威定义在 rdmd_detective.py，本文件只做 I/O 与退出码。
退出码：0 = 全部判定通过语义校验；1 = 存在 invalid 判定；2 = 输入/环境错误。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rdmd_detective import (  # noqa: E402
    VERDICT_FIELDS, Detective, build_case_prompt, check_case_contract, parse_completion,
    read_cases, summarize_contract_problems,
)


def emit(record: dict, handle) -> None:
    handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    handle.flush()


def contract_record(case: dict, problems: list[str]) -> dict:
    """输入不在训练契约内时产出的记录：规范空判定 + valid=false，且**不推理**。

    与 failure_record 分开，是因为这是调用方的问题（图缺字段），不是运行时故障，
    修法完全不同。warning 用 `input_contract_violation:` 前缀，便于流水线直接分流。
    """
    blank = parse_completion("")
    return {
        "id": case.get("id", ""),
        "verdict": {key: blank.get(key, "") for key in VERDICT_FIELDS},
        "raw": "",
        "valid": False,
        "warnings": [f"input_contract_violation:{summarize_contract_problems(problems)}"],
    }


def failure_record(case: dict, exc: BaseException) -> dict:
    """一条输入炸掉时产出的判定记录。

    整批中断是不能接受的：退出码要驱动流水线，一条过长或畸形的输入不该把后面所有 case 一起丢掉，
    也不该让调用方分不清「服务崩了」和「这条不可信」。所以失败被降级成一条 valid=false 的记录，
    verdict 用规范空判定（等价于弃权），warning 里带上异常类型。
    """
    blank = parse_completion("")
    return {
        "id": case.get("id", ""),
        "verdict": {key: blank.get(key, "") for key in VERDICT_FIELDS},
        "raw": "",
        "valid": False,
        "warnings": [f"inference_error:{type(exc).__name__}"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="RDMD reverse-detective inference")
    parser.add_argument("--input", required=True, help=".json (single case / case list) or .jsonl")
    parser.add_argument("--output", default="", help="JSONL output path; default stdout")
    parser.add_argument("--model", default=os.environ.get("RDMD_BASE_MODEL", ""),
                        help="base model dir; or set RDMD_BASE_MODEL")
    parser.add_argument("--adapter", default=os.environ.get("RDMD_ADAPTER", ""),
                        help="LoRA adapter dir; or set RDMD_ADAPTER")
    parser.add_argument("--max-new-tokens", type=int, default=160)
    parser.add_argument("--device", default=os.environ.get("RDMD_DEVICE", "cuda:0"))
    parser.add_argument("--dry-run", action="store_true",
                        help="只拼 prompt 并打印 sha256，不加载模型（无 GPU 也能验契约）")
    args = parser.parse_args()

    try:
        cases = read_cases(Path(args.input))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"[error] cannot read input: {exc}", file=sys.stderr)
        return 2

    if args.dry_run:
        # dry-run 就是「验契约」模式，所以它必须把契约问题**报出来**而不是抛异常：
        # 它的用途是让你在无 GPU 时看清这批输入能不能用。
        out = open(args.output, "w", encoding="utf-8") if args.output else sys.stdout
        violations = 0
        try:
            for case in cases:
                problems = check_case_contract(case)
                if problems:
                    violations += 1
                    print(json.dumps({
                        "id": case.get("id", ""),
                        "contractProblems": problems,
                    }, ensure_ascii=False), file=out)
                    continue
                prompt = build_case_prompt(case)
                print(json.dumps({
                    "id": case.get("id", ""),
                    "promptChars": len(prompt),
                    "promptSha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
                    "prompt": prompt,
                }, ensure_ascii=False), file=out)
        finally:
            if out is not sys.stdout:
                out.close()
        if violations:
            print(f"[ERROR] {violations}/{len(cases)} cases violate the input contract "
                  f"(missing rich fields) -- the model would answer confidently from empty fields",
                  file=sys.stderr)
            return 1
        return 0

    if not args.adapter and not args.model:
        print("[error] pass --adapter and --model (or set RDMD_ADAPTER / RDMD_BASE_MODEL)", file=sys.stderr)
        return 2
    if args.adapter and not Path(args.adapter, "adapter_config.json").is_file():
        print(f"[error] adapter_config.json not found in {args.adapter}", file=sys.stderr)
        return 2

    print(f"[load] base={args.model or '(adapter only)'} adapter={args.adapter or '(none)'} device={args.device}",
          file=sys.stderr)
    detective = Detective(args.model, args.adapter, device=args.device, max_new_tokens=args.max_new_tokens)

    out = open(args.output, "w", encoding="utf-8") if args.output else sys.stdout
    invalid = 0
    try:
        for index, case in enumerate(cases, start=1):
            # 契约检查在推理**之前**：不合格的输入不该占用 GPU，更不该拿到一个看起来正常的判定。
            problems = check_case_contract(case)
            if problems:
                invalid += 1
                result = contract_record(case, problems)
                emit(result, out)
                print(f"[{index}/{len(cases)}] {result['id'] or '-'} -> CONTRACT "
                      f"{result['warnings'][0]}", file=sys.stderr)
                continue
            try:
                result = detective.predict(case)
            except Exception as exc:  # noqa: BLE001 - 单条失败不得中断整批，见 failure_record
                invalid += 1
                result = failure_record(case, exc)
                emit(result, out)
                print(f"[{index}/{len(cases)}] {result['id'] or '-'} -> ERROR "
                      f"{type(exc).__name__}: {exc}", file=sys.stderr)
                continue
            invalid += 0 if result["valid"] else 1
            emit(result, out)
            verdict = result["verdict"]
            detail = f" {verdict['nodeId']}" if verdict["nodeId"] else ""
            if not result["valid"]:
                detail += f"  (invalid: {','.join(result['warnings'])})"
            print(f"[{index}/{len(cases)}] {result['id'] or '-'} -> {verdict['status']}{detail}", file=sys.stderr)
    finally:
        if out is not sys.stdout:
            out.close()

    print(f"[done] {len(cases)} cases, {invalid} invalid", file=sys.stderr)
    return 1 if invalid else 0


if __name__ == "__main__":
    sys.exit(main())
