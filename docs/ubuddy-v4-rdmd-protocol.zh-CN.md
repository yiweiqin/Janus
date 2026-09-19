# V4 阶段 3：反向侦探数据协议

> 配套代码：`src/shared/contracts/uBuddyReverseDetective.js`  
> 可训练数据盘：[../experiments/rdmd_detective_dataset/DATASET_CARD.zh-CN.md](../experiments/rdmd_detective_dataset/DATASET_CARD.zh-CN.md)  
> 生成与校验：`experiments/rdmd_detective_dataset/generate.mjs`、`validate.mjs`  
> SFT 与开训：`prepare_sft.mjs`、[TRAINING_RUNBOOK](../experiments/rdmd_detective_dataset/TRAINING_RUNBOOK.zh-CN.md)

## 样本

```text
id, split, graph_id, G_star, G_prime,
label.status, label.injected_node, label.injected_type, label.injected_edge,
label.injected_form, label.hop_to_first_effect,
changed_node_ids, generator_id, seed
```

- `G_star`：原正确路径（推理时对应规划树）
- `G_prime`：注入一次最小改动并传播后的路径（推理时对应执行树）
- 标签是注入点，不是全部变点
- 主监督：每次只注入一次
- 无注入对照：标签 `no_drift`
- 双注入（两条不相交分支）：只评测 `UNKNOWN`，不进主监督

漂移类型：`missing_dependency | wrong_agent | wrong_version | wrong_acceptance | local_replan`

类型可统一，形态必须随任务变：同一 `wrong_version` 在研究里是观察年窗口，在开发里是 API 钉死，在运营里是旧部署清单。标签额外记录 `injected_form`。

切分按 `graph_id` 族，同一条原路径的所有注入不能同时出现在训练和测试。

当前 v2 盘：单注入 10,000 + 无漂移 1,000 + UNKNOWN 1,000。`G_star` 为 16–28 步长程图；单注入要求第一处可见后代后果至少在第 3 跳。结构启发式不应再接近满分。

## 侦探输出

```text
status: drift | no_drift | UNKNOWN
nodeId, edgeId, type, evidenceNodeIds
```

第一版只定位。`wrong_agent` 交给方案二替换；结构类交给最小改规划；`UNKNOWN` / `no_drift` 只记诊断。

## 非训练基线

变化子图的唯一源点，只看 title/agent/version/acceptance/边，不看 summary/output。用于对照：规则 version 后缀盘会满分；内容层部分传播盘应明显低于 100%。它不是论文里的已训练模型。
