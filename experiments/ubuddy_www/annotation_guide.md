# 过程归因双人盲标指南

标注者只读取脱敏 trace、官方 evaluator 和 fault manifest 的隐藏副本，不读取方法名。每条轨迹允许多个原因。

组织层标签：`task_decomposition`、`collaborator_selection`、`stale_profile`、`dependency_order`、`requirement_revision`、`result_versioning`。

个体层标签：`capability_gap`、`tool_execution_failure`、`memory_failure`、`verification_failure`。

无法由证据确定时标记 `insufficient_evidence`，不得强行归因。每个标签必须附 `evidenceRefs`，引用 event ID 或 official evaluator 字段。两名标注者独立完成，第三人只仲裁不一致项。

评分：多标签 macro-F1、组织/个体责任层混淆率、证据 precision/recall、多原因 IoU、阻断准确率和 Cohen's kappa。

