# 能力画像依赖集束：组织世界

这一份数据是第二份 8B QLoRA（依赖分 / 相似度）的世界初始化，不是反向侦探那份图数据。

每人 1 个 uBuddy + 5 个 specialist。Agent 技能按职能互补、按细节能力近邻。uBuddy 初始画像由手下 5 个 Agent 聚合。配对上只保存依赖分 \(D\) 和相似度 \(S\)，禁止合成总分。

## 生成

```bash
npm run experiment:cpdb-world
npm run experiment:cpdb-world:test
npm run experiment:cpdb-world:smoke
```

输出在 `experiments/cpdb_org_world/data/full/`。

## 人工标注

打开 `ANNOTATION.zh-CN.md`。本地标注页：

```bash
npm run experiment:cpdb-annotate
```

浏览器打开 http://127.0.0.1:8766/ 。

需要 **3 个人**：甲、乙在 `test` 上各自**盲标**一遍（互相看不到对方，也不看预标和参考分），丙只仲裁 test 分歧，并顺手复核 development / train 的预标。每张卡分开打依赖分和相似度，不要打总分。

标完看一致性：`npm run experiment:cpdb-agreement`。导出 gold：`npm run experiment:cpdb-apply-labels`（只导出 `已单标` / `双人一致` / `已仲裁`，AI 预标和未裁决的分歧不导出）。
