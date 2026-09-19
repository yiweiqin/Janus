# V4 阶段 4：能力画像依赖集束标注与选人协议

> 配套代码：`src/shared/contracts/uBuddyCapabilityDependencyBundle.js`  
> 画像字段沿用 `uBuddyCapabilityProfile`：`capabilityTags`、`supportedTaskTypes`、`deliverableTypes`。

## 两个分数，禁止合成

| 分数 | 问什么 | 用于 | 标注提示 |
|---|---|---|---|
| 依赖分 \(D(A,B)\) | A 的产出是否适合作为 B 的输入 | 规划选协作 | 0–1，整理→写作高，两个 PPT 低 |
| 相似度 \(S(A,B)\) | A 与 B 的能力是否邻近 | 失败后替换 | 0–1，两个 PPT 高，整理与写作低 |

人工可直接打分。初始化用画像；合作成功：

```text
D ← D + η · δ · exp(−λ · n_success)
```

失败不把 D 打到零，先做替换实验。相似度不因单次成败大改。规划时冻结能力选择快照。

当前合成世界：`experiments/cpdb_org_world/`（120 人 × 5 Agent，uBuddy 画像由手下聚合）。生成：`npm run experiment:cpdb-world`。人工标注：`npm run experiment:cpdb-annotate`（见 `experiments/cpdb_org_world/ANNOTATION.zh-CN.md`）。

## 替换实验

1. 固定任务、规划结构、下游 Agent 和验收器
2. 用 `argmax S(x, A)` 替换失败的 A
3. 对照：相似替换 / 随机替换 / 只改规划不换人
4. 相似替换明显更好 → 归因到 A 与替代者的 capabilityTags 差
5. 都不好 → 交回方案一，不继续换人

## 标注字段

```text
left_agent_id, right_agent_id,
dependency_score, similarity_score,
annotator_id, rationale
```

依赖分和相似度必须分开保存。不能标注“一个依赖集束总分”。
