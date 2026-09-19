# TDB 文档索引

> **研究主张已切换（2026-09-10）。** 当前方案主线是 `Janus/docs` 下的 V4 自进化收束稿，不再把最小披露 / TDB 投影当作论文贡献。本目录仍是 **TDB 代码与历史实验** 的事实入口。

阅读顺序：先看 [`current/UBUDDY_TDB_MAINLINE_METHOD.zh-CN.md`](current/UBUDDY_TDB_MAINLINE_METHOD.zh-CN.md)，再看 [`current/README.zh-CN.md`](current/README.zh-CN.md) 和契约文件。主线方法文档吸收了历史训练目标、模型卡、评审结论和方向打分设计中的有效内容；原文仍在 `archive/` 供追溯。

`archive/` 只用于追溯历史，不作为当前规范；`pending/` 表示代码尚未支持或尚未验证的设计。

目录规则：代码变更后只更新 `current/`；旧版本不得留在根目录；新设计在进入代码前放入 `pending/`。

兼容说明：根目录 real-task.template.json 保留为测试与 CLI 兼容入口，规范副本位于 pending/。
