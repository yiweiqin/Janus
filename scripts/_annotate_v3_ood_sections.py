# -*- coding: utf-8 -*-
"""在 V3 报告 §12 / §13 的标题下各插一条**更正指向**。

为什么改一份历史报告：§12–13 的模型列（以及它们的 `data/*_summary.json` 落脚点）说的是
**当时的探针**，而探针后来被重造过。报告不改的话，读的人会把它当成今天探针上的数字
—— 而这两件事的差别是 45 vs 43 行、以及 60 行里有 35 个 verdict id 今天根本不存在。
改的是**指向**，不是数字：数字是当时真实测出来的，抹掉它们才是伪造。
"""
import io
import sys

PATH = 'experiments/rdmd_detective_dataset/V3_FULL_REPORT.zh-CN.md'

NOTES = {
    '## 12. 分布外探针：换一种流程还行不行': (
        '> **2026-09-19 更正指向（P4）**：本节的分组表来自 `data/ood_summary.json`，\n'
        '> 它描述的是**当时那一版探针**。探针后来被重造过（43 行 → **45 行**，\n'
        '> 刻意造的派生字段行 10 → **13**），而汇总没有跟着重跑。\n'
        '> 基线列已由 `data/ood_baseline.json` + `npm run experiment:rdmd-ood:gate` 重新钉住；\n'
        '> **模型列需要用当前探针重跑一次模型才能刷新**（那一步要 GPU）。\n'
        '> 详见 `ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md` §14。'
    ),
    '## 13. 对抗探针：该弃权的时候会不会硬猜': (
        '> **2026-09-19 更正指向（P4）**：同上，本节的分组表来自 `data/adv_summary.json`，\n'
        '> 它来自一个更早的探针版本（`byScale` 当时只有一组 `20`，今天的 `scale` 是真节点数\n'
        '> `20/27/28/29`）。更要紧的是：`adv_verdicts.jsonl` 的 60 个 id 里**有 35 个\n'
        '> 在今天 60 行的标签里不存在**（旧命名 `_220.._249` vs 今天 `_2.._60`），\n'
        '> 所以本节的模型列**无法**用今天的语料复现。基线列已由 `data/adv_baseline.json` +\n'
        '> `npm run experiment:rdmd-ood:gate` 重新钉住，其中「2 行标签与基线不一致」是\n'
        '> 被显式记下的不变量。详见 `ubuddy_recon/PLAN_EXEC_TRUTH.zh-CN.md` §14。'
    ),
}


def main() -> int:
    text = io.open(PATH, encoding='utf-8').read()
    if '更正指向（P4）' in text:
        print('already present, skip')
        return 0
    lines = text.split('\n')
    out = []
    inserted = 0
    for line in lines:
        out.append(line)
        note = NOTES.get(line)
        if note:
            # 标题下原本紧跟一个空行，把注插在空行之后 —— 贴着标题会破坏某些渲染器的锚点。
            out.append('')
            out.append(note)
            inserted += 1
    if inserted != len(NOTES):
        print(f'插入位置没找全（{inserted}/{len(NOTES)}）—— 标题被改过？', file=sys.stderr)
        return 1
    io.open(PATH, 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
    print(f'inserted {inserted} notes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
