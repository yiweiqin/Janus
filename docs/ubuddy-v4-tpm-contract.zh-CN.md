# V4 阶段 2：任务公共 memory 契约

> 配套代码：`src/shared/contracts/uBuddyTaskPublicMemory.js`  
> 主张：[ubuddy-pain-points-innovations-v4-claim-freeze.zh-CN.md](ubuddy-pain-points-innovations-v4-claim-freeze.zh-CN.md)  
> 审查是工程门禁，不是研究贡献。

## 对象

每个任务一份 `TaskPublicMemory`：

```text
taskId, ownerUserId, participantUserIds
foundation.plan   G_plan
foundation.exec   G_exec
elevation[]       省检通过的摘要
raw[]             原始上下文，默认不可见
```

可复用现有底座，不新建平行世界模型：

| TPM 字段 | 现有落点 |
|---|---|
| `foundation.plan / exec` | 协作图节点边 + `task_nodes` / `task_events` |
| `elevation` | Work Memory 公开摘要 / work digest |
| `raw` | 私有会话、完整文件、未脱敏中间产物 |
| 访问审计 | `work_memory_access_audits` |
| 省检脱敏 | `sanitizeCollaborationPublicValue` 已有规则 |

## 默认投影

| 观察者 | 基础层 | 提升层 | 原始层 |
|---|---|---|---|
| 本任务参与者 | 开 | 开 | 关，需授权 |
| 其他任务 / 非参与者 | 关 | 关 | 关，需授权 |

省检失败的原始条目不进提升层，也不写入基础层。密钥、路径、口令直接丢弃。

## 原始层申请

```text
createRawAccessRequest
  → reviewRawAccessByAi    pass | reject | need_human
  → reviewRawAccessByOwner approve | deny   （仅 pass / need_human 进入）
  → grant：短时、只读、可撤回、可按 nodeIds 切片；excerptOnly 时截断正文
```

AI 预审只做规则：缺用途、窗口为空、窗口过宽且要全文、目标任务不匹配、明文密钥。不训练专用模型。

落地时建议新增申请/授权表，读路径复用 `work_memory_access_audits`，不要把 grant 写进 TDB 或披露 frontier。
