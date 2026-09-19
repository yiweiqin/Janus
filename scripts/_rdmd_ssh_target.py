"""RDMD 盒子 SSH 端点的**唯一**解析点。

为什么要有这个文件
==================

在它之前，11 个脚本各自写了同一行：

    port=int(os.environ.get("RDMD_SSH_PORT", "53957"))

那个默认值是个陷阱。53957 是**另一个已经不在用的实例**端口（`_probe_ubuddy_cloud.sh`
的注释还专门提过它），当前盒子在 48096（`scripts/_rdmd_env.ps1`）。于是"忘了 source
环境变量"这件事不会报错，只会得到一个连不上的端口 —— 排查时间全花在"是不是盒子挂了"，
而不是"我少跑了一行 source"。

所以这里**不给默认值**：缺 host/port 就 fail closed，并直接告诉你该跑哪一行。
认证信息同样只从环境读，绝不落盘（与 `rdmd_gpu_worker.py` 的密钥纪律一致）。
"""
from __future__ import annotations

import os

# 只在提示信息里出现，不作为连接默认值 —— 见到它就该去 source `_rdmd_env.ps1`。
ENV_HELPER = "scripts/_rdmd_env.ps1"
SOURCE_HINT = f"先在本机执行：. {ENV_HELPER}"


def password_from_env() -> str:
    """口令。只认环境变量，两个名字都支持（历史脚本用得不一致）。"""
    password = os.environ.get("RDMD_SSH_PASSWORD") or os.environ.get("SSH_PASSWORD")
    if not password:
        raise SystemExit(f"RDMD_SSH_PASSWORD is required（{SOURCE_HINT}）")
    return password


def port_from_env() -> int:
    raw = (os.environ.get("RDMD_SSH_PORT") or "").strip()
    if not raw:
        # 故意不回落到 53957：那会把"忘了 source"伪装成"盒子连不上"。
        raise SystemExit(
            f"RDMD_SSH_PORT is not set（{SOURCE_HINT}）。"
            "这里刻意不设默认端口 —— 旧默认值 53957 是另一个实例，"
            "静默回落到它只会让连接失败看起来像盒子挂了。"
        )
    try:
        port = int(raw)
    except ValueError as error:
        raise SystemExit(f"RDMD_SSH_PORT 必须是整数，收到 {raw!r}") from error
    if not (0 < port < 65536):
        raise SystemExit(f"RDMD_SSH_PORT 超出端口范围：{port}")
    return port


def host_from_env() -> str:
    host = (os.environ.get("RDMD_SSH_HOST") or "").strip()
    if not host:
        raise SystemExit(f"RDMD_SSH_HOST is not set（{SOURCE_HINT}）")
    return host


def user_from_env() -> str:
    return (os.environ.get("RDMD_SSH_USER") or "root").strip() or "root"


def target_from_env() -> dict:
    """`{hostname, port, username, password}`，直接喂给 `paramiko.connect()`。"""
    return {
        "hostname": host_from_env(),
        "port": port_from_env(),
        "username": user_from_env(),
        "password": password_from_env(),
    }


def connect(timeout: int = 30):
    """建一个 SSH client。**只此一处**构造连接参数。"""
    import paramiko

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        **target_from_env(),
        timeout=timeout,
        allow_agent=False,
        look_for_keys=False,
    )
    return client
