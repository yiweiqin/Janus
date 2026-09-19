"""用盒子上的**本地 Qwen3-8B** 给 CPDB 的 pair 打分，产出一份可训练的 AI 标签。

## 为什么是本地模型

方案二要的是「人工标注完让模型去训练」。人标一时半会做不了，于是退一步：
先让一个 AI 把这两轴判一遍，用它的判分当监督信号训一个**小**模型。
关键在于这两件事要分开看：

  - 「用什么当老师」是**数据问题**，可以随标注质量升级（人标 → 强模型 → 专家裁定）；
  - 「模型能不能把老师学下来、并且便宜地跑在服务端」是**工程问题**，本脚本连同
    `train_scorer.py` 要证明的就是后者。

外网在这个盒子上只通 PyPI 镜像（HF 不通），所以老师只能是本地权重。
恰好 `/root/autodl-tmp/models/Qwen3-8B` 是全的，三张 A800 也空着 —— 不必等外部 API。

## 判分口径照抄导出包，不自创

prompt 里的两个轴、五个档位、锚点，全部来自 `export/ai-judge-v1/TASK.json`。
这不是形式主义：如果裁判口径和导出包不一致，那「本机 AI 判的分」与「外部 AI 判的分」
就变成两个不同的任务，之后 import 进来的标签没法混着用。判据是**同一套问题**。

## 两位裁判怎么来的

`TASK.json` 要求同一 pair 至少两份互不可见的判分。这里做不到「两个真正独立的人」，
做不到就不假装做到，而是把「不稳定」本身量出来：
  - reviewer A：贪心解码 + 口径 A —— 主标签，可复现（同样的输入必得同样的分）；
  - reviewer B：固定种子的采样解码 + 口径 B（换一种问法）—— 只用来算一致率。

因此报告里的 `agreement` 必须读作**跨问法的稳定性**，不是标注者间一致性。
把这两种东西混为一谈，是把「模型对问法敏感」误报成「标注噪声」。

## 只准看见卡片，不准看见答案

输入是 `export/ai-judge-v1/cards/*.jsonl` —— 导出时已经把 `teacher` / `human` /
`contract*` 全部剥掉了。所以裁判无从抄答案，它给出的分歧就是真分歧。
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

SCALE = [0.0, 0.25, 0.5, 0.75, 1.0]
SYSTEM = "你是一个严格的标注员。你只输出一行 JSON，不输出任何解释或多余文字。"

# 两个口径：同一个问题的两种问法。B 刻意换了语序与举例顺序，
# 用来暴露「模型其实在依赖位置/措辞而不是内容」这种情况。
FRAMINGS = {
    "a": """你要给一对 Agent 打两个分。分数只能取 {scale} 之一，不允许别的值。

【第一轴 dependency —— 规划时左方的产出是否适合作为右方的输入？】
  （只看产物流向，不要看这两个 Agent 像不像）
  0.0 = 左方的产出与右方的输入完全对不上
  0.25 = 只有很边缘的对应
  0.5 = 有部分对应，缺了还得补别的
  0.75 = 基本对得上，是右方的主要输入之一
  1.0 = 左方的产出正好是右方的核心输入

【第二轴 similarity —— 若左方执行不佳，右方是否适合做「最小能力改动」的替换？】
  （只看换上去改动大不大，不要看这两个 Agent 是否该协作）
  0.0 = 职能不同，换上去等于换了件事
  0.25 = 大方向沾边，但细节能力差得远
  0.5 = 同大职能，细节能力只有部分重合
  0.75 = 同大职能，细节能力大部分重合
  1.0 = 同职能且细节能力几乎重合，换上去改动最小

【左方 Agent】
{left}

【右方 Agent】
{right}

只输出一行 JSON，两个值都必须严格落在 {scale} 里：
{{"dependency": <分数>, "similarity": <分数>}}""",
    "b": """请评估下面两个 Agent 的关系，输出两个彼此独立的分数，取值只能从 {scale} 里挑。

先看右方需要什么输入、左方能产出什么：左方产出落在右方输入里的程度，决定 dependency。
锚点：完全对不上取 0.0；正好是核心输入取 1.0；中间按对应程度取 0.25 / 0.5 / 0.75。

再看假如左方做得不好、要换一个 Agent，右方顶上去需要改多少细节能力，改动越小 similarity 越高。
锚点：不同职能取 0.0；同职能且细节能力几乎重合取 1.0；中间按重合程度取 0.25 / 0.5 / 0.75。

右方 Agent：{right}

左方 Agent：{left}

输出一行 JSON：{{"dependency": <分数>, "similarity": <分数>}}""",
}


def render_side(side: dict) -> str:
    lines = [
        f"名称：{side.get('name', '')}（主职能：{side.get('family', '')}；细节能力：{side.get('facet', '')}）",
        f"标签：{'、'.join(side.get('tags') or []) or '无'}",
        f"产出：{'、'.join(side.get('produces') or []) or '无'}",
        f"输入：{'、'.join(side.get('consumes') or []) or '无'}",
    ]
    if side.get("skillDigest"):
        lines.append(f"技能摘要：{side['skillDigest']}")
    return "\n".join(lines)


def build_prompt(card: dict, framing: str) -> str:
    scale = " / ".join(str(item) for item in SCALE)
    return FRAMINGS[framing].format(
        scale=scale,
        left=render_side(card.get("left") or {}),
        right=render_side(card.get("right") or {}),
    )


JSON_OBJECT = re.compile(r"\{[^{}]*\}")
NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def parse_scores(text: str) -> tuple[float, float, str]:
    """从模型输出里抠出两个分数。

    返回 `(dependency, similarity, note)`；抠不出来就给 `(-1, -1, 原因)`。
    这里**不做任何补全或猜测**：猜出来的分数会变成训练标签，而错的标签比没有标签更糟 ——
    它不会被任何后来的检查发现。所以宁可记为 invalid 并计数。

    **从后往前找**：思考模式下正文里会先出现一段推理（可能顺带引用了 prompt 里的
    `{"dependency": <分数>, ...}` 模板），真正的答案在最后。正着找会撞上模板那个
    （`json.loads` 因 `<分数>` 失败后继续，但推理段里也可能出现合法的中间结论），
    倒着找则天然命中最终答案。
    """
    for candidate in reversed(JSON_OBJECT.findall(text or "")):
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if "dependency" not in parsed or "similarity" not in parsed:
            continue
        pair = []
        for axis in ("dependency", "similarity"):
            raw = parsed[axis]
            value = raw if isinstance(raw, (int, float)) else None
            if value is None:
                found = NUMBER.search(str(raw))
                value = float(found.group()) if found else None
            if value is None or float(value) not in SCALE:
                return -1.0, -1.0, f"off_scale:{axis}={raw!r}"
            pair.append(float(value))
        return pair[0], pair[1], "ok"
    return -1.0, -1.0, "no_json"


def read_jsonl(path: Path) -> list[dict]:
    with path.open("r", encoding="utf8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def load_model(model_path: str, gpu: int):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    # 左填充：只有左填充才能让一批里所有序列在同一位置开始生成，
    # 右填充会让短序列的生成从 padding 中间穿过去。
    tokenizer.padding_side = "left"
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        dtype=torch.bfloat16,
        device_map={"": f"cuda:{gpu}"} if torch.cuda.is_available() else None,
        trust_remote_code=True,
    )
    model.eval()
    return tokenizer, model


def build_prompts(tokenizer, cards: list[dict], framing: str, thinking: bool = False) -> list[str]:
    texts = []
    for card in cards:
        messages = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": build_prompt(card, framing)},
        ]
        try:
            texts.append(tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True, enable_thinking=thinking,
            ))
        except TypeError:
            # 老版本模板不接受 enable_thinking 时退回默认；Qwen3 会带思考段，
            # 于是输出里多一层 <｜end▁of▁thinking｜> —— 解析器从后往前找 JSON，仍能兜住。
            texts.append(tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True))
    return texts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cards", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--raw-out", default="")
    parser.add_argument("--model", default="/root/autodl-tmp/models/Qwen3-8B")
    parser.add_argument("--gpu", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=48)
    parser.add_argument("--max-new-tokens", type=int, default=64)
    parser.add_argument("--framing", default="a", choices=sorted(FRAMINGS))
    parser.add_argument("--reviewer-id", default="qwen3-8b-greedy-a")
    parser.add_argument("--sample", action="store_true", help="采样解码（用于做稳定性对照）")
    parser.add_argument("--thinking", action="store_true", help="打开 Qwen3 的思考模式（更准，但慢得多）")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--every", type=int, default=1, help="每 N 张取一张，用来在小样本上先量一致性")
    parser.add_argument("--shard", default="0/1", help="i/n，用于多卡并行分片")
    args = parser.parse_args()

    import torch

    torch.manual_seed(args.seed)
    index, shards = (int(part) for part in args.shard.split("/"))
    if not (0 <= index < shards):
        raise SystemExit(f"shard 越界: {args.shard}")

    # 思考模式的输出会长一两个数量级：64 个 token 只够写半个推理段，
    # 于是「解析失败」会被误读成「模型不会」，其实是预算不够。
    if args.thinking and args.max_new_tokens <= 64:
        args.max_new_tokens = 1024

    cards: list[dict] = []
    for path in args.cards:
        cards += read_jsonl(Path(path))
    if args.every > 1:
        cards = [card for position, card in enumerate(cards) if position % args.every == 0]
    if args.limit:
        cards = cards[: args.limit]
    cards = [card for position, card in enumerate(cards) if position % shards == index]
    print(f"[judge] 载入 {len(cards)} 张卡片（shard {args.shard}），framing={args.framing} thinking={args.thinking}", flush=True)

    tokenizer, model = load_model(args.model, args.gpu)
    print(f"[judge] 模型已载入 cuda:{args.gpu}", flush=True)

    out_path = Path(args.out)
    raw_path = Path(args.raw_out) if args.raw_out else out_path.with_suffix(".raw.jsonl")
    started = time.time()
    counts = {"ok": 0, "invalid": 0}
    reasons: dict[str, int] = {}

    with out_path.open("w", encoding="utf8") as labels, raw_path.open("w", encoding="utf8") as raw:
        processed = 0
        for start in range(0, len(cards), args.batch_size):
            batch = cards[start:start + args.batch_size]
            prompts = build_prompts(tokenizer, batch, args.framing, thinking=args.thinking)
            inputs = tokenizer(prompts, return_tensors="pt", padding=True, truncation=True, max_length=2048)
            inputs = {key: value.to(model.device) for key, value in inputs.items()}
            with torch.no_grad():
                generated = model.generate(
                    **inputs,
                    max_new_tokens=args.max_new_tokens,
                    do_sample=bool(args.sample),
                    temperature=0.7 if args.sample else None,
                    top_p=0.9 if args.sample else None,
                    pad_token_id=tokenizer.pad_token_id,
                    eos_token_id=tokenizer.eos_token_id,
                )
            # 左填充 + 变长输入：只有按 input 的实际长度切，才能切掉 prompt 那段。
            for row, card in enumerate(batch):
                produced = generated[row][inputs["input_ids"].shape[1]:]
                text = tokenizer.decode(produced, skip_special_tokens=True)
                dependency, similarity, note = parse_scores(text)
                if note == "ok":
                    counts["ok"] += 1
                    labels.write(json.dumps({
                        "id": card["id"],
                        "reviewerId": args.reviewer_id,
                        "role": "reviewer",
                        "dependency": dependency,
                        "similarity": similarity,
                        "split": card.get("split"),
                        "kind": card.get("kind"),
                    }, ensure_ascii=False) + "\n")
                else:
                    counts["invalid"] += 1
                    reasons[note] = reasons.get(note, 0) + 1
                raw.write(json.dumps({
                    "id": card["id"], "note": note, "text": text[:400],
                }, ensure_ascii=False) + "\n")
            processed += len(batch)
            if processed % (args.batch_size * 10) == 0 or processed == len(cards):
                rate = processed / max(1e-9, time.time() - started)
                print(
                    f"[judge] {processed}/{len(cards)}  ok={counts['ok']} invalid={counts['invalid']} "
                    f"{rate:.1f}/s",
                    flush=True,
                )

    summary = {
        "reviewerId": args.reviewer_id,
        "framing": args.framing,
        "sample": bool(args.sample),
        "cards": len(cards),
        "ok": counts["ok"],
        "invalid": counts["invalid"],
        "invalidReasons": reasons,
        "seconds": round(time.time() - started, 1),
        "out": str(out_path),
    }
    Path(str(out_path) + ".summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
