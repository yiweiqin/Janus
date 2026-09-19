"""把 GPU worker 及其推理依赖上传到盒子，**不碰训练数据**。

为什么单独一个脚本，而不是复用 rdmd_remote_deploy.py：
后者是训练 bundle 的部署工具，INCLUDE 里含整个 `sft/`。在 v4 训练**正在跑**的时候
执行它，会用本地 sft 覆盖远端 sft —— 训练进程虽然已经把数据读进去了，但那是靠
"HF datasets 在启动时把数据映射进内存"这个假设，而它不是我该拿来赌的东西。
一个只想更新三个文件的动作，不该带上覆盖训练集的风险。

只上传三样东西，路径与训练 bundle 的布局**刻意保持一致**，这样 worker 在盒子上
零 env 覆盖即可运行（它的 `deploy_dir` 默认从自身位置推断）：

    scripts/rdmd_gpu_worker.py
    experiments/rdmd_detective_dataset/deploy/predict.py
    experiments/rdmd_detective_dataset/deploy/rdmd_detective.py

为什么必须一起传：worker 会 `import rdmd_detective` 读它的 `CONTRACT_VERSION`，
再与云侧下发的版本比对，**不一致就不产出判定**。盒子上曾经有一份**没有
CONTRACT_VERSION** 的旧 `rdmd_detective.py`（亲测 grep 为空），那份东西会让 worker
在启动时 AttributeError —— 失败得很响，是好事，但它说明"只更新 predict.py"是错的：
这两个文件与 worker 是同一个契约的实现，必须同一次部署。

用法：python scripts/rdmd_worker_deploy.py
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path

import paramiko

from _rdmd_ssh_target import connect as _connect_ssh  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]

# 远端根：训练 bundle 也解压到这里（/root/autodl-tmp/Janus/...），保持一致。
REMOTE_ROOT = "/root/autodl-tmp"

FILES = [
    "scripts/rdmd_gpu_worker.py",
    "experiments/rdmd_detective_dataset/deploy/predict.py",
    "experiments/rdmd_detective_dataset/deploy/rdmd_detective.py",
    # 盒子上**由人来跑**的运维脚本也要跟代码一起部署：启停 worker 的人不该还需要
    # 从开发机把它拷过去（那就等于"部署靠记忆"）。这些是本机工具（下划线前缀），
    # 所以不会进 git，但它们在盒子上是产品的一部分。
    "scripts/_rdmd_worker_daemon.sh",
    "scripts/_rdmd_worker_provision.sh",
]


def connect() -> paramiko.SSHClient:
    # 端点解析只有一处实现（scripts/_rdmd_ssh_target.py）：缺 RDMD_SSH_HOST/PORT
    # 就 fail closed，不再静默回落到另一个实例的端口。
    return _connect_ssh()


def run(client: paramiko.SSHClient, command: str, timeout: int = 120) -> tuple[int, str, str]:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    return stdout.channel.recv_exit_status(), out, err


def main() -> None:
    client = connect()
    try:
        sftp = client.open_sftp()
        try:
            for rel in FILES:
                local = ROOT / rel
                if not local.is_file():
                    raise SystemExit(f"本地缺文件: {rel}")
                remote = f"{REMOTE_ROOT}/Janus/{rel}"
                code, out, err = run(client, f"mkdir -p {os.path.dirname(remote)}")
                if code != 0:
                    raise SystemExit(f"mkdir_failed:{err.strip()}")
                # 先传成 .tmp 再 mv：中途断线不会留下一个半截的 .py，
                # 而半截的 .py 在盒子上会以 SyntaxError 的形式被发现，浪费一轮排查。
                sftp.put(str(local), f"{remote}.tmp")
                code, out, err = run(client, f"mv {remote}.tmp {remote} && sha256sum {remote}")
                if code != 0:
                    raise SystemExit(f"move_failed:{err.strip()}")
                remote_hash = out.strip().split()[0]
                local_hash = hashlib.sha256(local.read_bytes()).hexdigest()
                status = "OK  " if remote_hash == local_hash else "FAIL"
                print(f"  {status} {rel}  {remote_hash[:16]}")
                if remote_hash != local_hash:
                    raise SystemExit(f"hash_mismatch:{rel}")
        finally:
            sftp.close()

        # 传完立刻验证两件会让 worker 直接失败的事，而不是等第一次领活才发现。
        checks = [
            ("worker --help 可运行",
             f"{REMOTE_ROOT}/rdmd-env/bin/python {REMOTE_ROOT}/Janus/scripts/rdmd_gpu_worker.py --help >/dev/null 2>&1 && echo YES || echo NO"),
            ("rdmd_detective 有 CONTRACT_VERSION",
             f"grep -c 'CONTRACT_VERSION' {REMOTE_ROOT}/Janus/experiments/rdmd_detective_dataset/deploy/rdmd_detective.py"),
            ("worker 能读出契约版本（import 成功才算）",
             f"cd {REMOTE_ROOT}/Janus/experiments/rdmd_detective_dataset/deploy && "
             f"{REMOTE_ROOT}/rdmd-env/bin/python -c \"import rdmd_detective;print(rdmd_detective.CONTRACT_VERSION)\""),
        ]
        failures = []
        for label, command in checks:
            code, out, err = run(client, command, timeout=180)
            text = (out + err).strip()
            print(f"  {label}: {text.splitlines()[-1] if text else '(空)'}")
            if label.startswith("rdmd_detective 有"):
                if text.strip() in ("0", ""):
                    failures.append(label)
            elif label.startswith("worker 能读出"):
                if "ubuddy_plan_exec" not in text:
                    failures.append(label)
            elif "YES" not in text:
                failures.append(label)
        if failures:
            raise SystemExit(f"worker_deploy_verify_failed: {failures}")
        print("worker_deploy_ok")
    finally:
        client.close()


if __name__ == "__main__":
    main()
