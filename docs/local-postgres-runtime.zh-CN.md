# Janus 本机 PostgreSQL 实验环境

本机实验环境使用 PostgreSQL 17，数据库仅监听 `127.0.0.1` 和 `::1`，数据目录为：

```text
D:\PostgreSQL\17\data
```

数据库服务名为 `postgresql-x64-17`，启动类型为“手动”。API、Worker 和数据库密码均保存在当前 Windows 用户环境变量中，不写入仓库。

## 启动

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local-janus-start.ps1
```

数据库停止时会弹出 UAC，用于启动 Windows 服务。

## 查看状态

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local-janus-status.ps1
```

## 运行 uBuddy 真实链路冒烟实验

确认 PostgreSQL、Cloud API 和 Evolution Worker 已启动后运行：

```powershell
npm run experiment:ubuddy:postgres-smoke
```

该命令不调用大模型。实验结果保存在 `experiments/runs/postgres-smoke-<timestamp>/`，其中 `metrics.json` 的 `smokePass` 表示数据库/API 数据不变量是否全部通过；它不代表论文级性能提升已经得到证明。

## 停止 API 和 Worker

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local-janus-stop.ps1
```

同时停止 PostgreSQL：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local-janus-stop.ps1 -StopDatabase
```

本机没有配置 MinIO/S3，因此 `/readyz` 会将对象存储标为未配置；`/healthz`、数据库迁移、uBuddy 协作状态与 Evolution Worker 不受这一项影响。
