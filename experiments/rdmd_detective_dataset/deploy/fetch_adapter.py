"""把训练好的 LoRA adapter 从训练机拉到本地。

为什么不把 adapter 直接提交进仓库：174 MB 的权重进 git 会让仓库永久膨胀，而且
adapter 只有配上 Qwen3-8B 基座才能用 —— 它天然属于「部署环境」而不是「源码」。
所以这里给的是**可复现的拉取方式**，默认落到已被 .gitignore 忽略的 rdmd_runs/ 下。

用法：
    set RDMD_SSH_PASSWORD=...        # 或 SSH_PASSWORD
    python fetch_adapter.py                       # 拉到默认位置
    python fetch_adapter.py --dest D:\\models\\rdmd-v3 --run-tag qlora-v3

连接参数默认与 scripts/rdmd_ssh.py 一致，可用 RDMD_SSH_HOST / RDMD_SSH_PORT /
RDMD_SSH_USER 覆盖，也可用命令行 --host/--port/--user。
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # repo root

REMOTE_RUNS = "/root/autodl-tmp/rdmd_runs"
DEFAULT_DEST = ROOT / "experiments" / "rdmd_runs"

# adapter 目录里的东西都要：权重 + tokenizer + chat template。
# 少 tokenizer 就跑不起来（Detective 从 adapter 目录读 tokenizer）。
REQUIRED = ("adapter_config.json", "adapter_model.safetensors")


def human(num: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024 or unit == "GB":
            return f"{num:.1f}{unit}" if unit != "B" else f"{num}B"
        num /= 1024
    return f"{num:.1f}GB"


def pull(sftp, remote_dir: str, local_dir: Path) -> list[tuple[str, int]]:
    """递归下载。paramiko 的 SFTP 没有内建递归 get，这里自己走目录。"""
    local_dir.mkdir(parents=True, exist_ok=True)
    fetched: list[tuple[str, int]] = []
    for entry in sorted(sftp.listdir_attr(remote_dir), key=lambda item: item.filename):
        remote_path = f"{remote_dir}/{entry.filename}"
        local_path = local_dir / entry.filename
        if entry.st_mode & 0o040000:  # directory
            fetched.extend(pull(sftp, remote_path, local_path))
            continue
        sftp.get(remote_path, str(local_path))
        fetched.append((entry.filename, entry.st_size))
    return fetched


def main() -> int:
    parser = argparse.ArgumentParser(description="fetch the RDMD LoRA adapter from the training box")
    parser.add_argument("--host", default=os.environ.get("RDMD_SSH_HOST", "connect.bjb1.seetacloud.com"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("RDMD_SSH_PORT", "53957")))
    parser.add_argument("--user", default=os.environ.get("RDMD_SSH_USER", "root"))
    parser.add_argument("--run-tag", default="qlora-v3")
    parser.add_argument("--remote-adapter", default="", help="覆盖远端 adapter 目录（默认 <runs>/<run-tag>/adapter）")
    parser.add_argument("--dest", default="", help=f"本地目录（默认 {DEFAULT_DEST}）")
    args = parser.parse_args()

    password = os.environ.get("RDMD_SSH_PASSWORD") or os.environ.get("SSH_PASSWORD")
    if not password:
        print("[error] RDMD_SSH_PASSWORD (or SSH_PASSWORD) is required", file=sys.stderr)
        return 2

    remote_adapter = args.remote_adapter or f"{REMOTE_RUNS}/{args.run_tag}/adapter"
    dest_root = Path(args.dest) if args.dest else DEFAULT_DEST
    local_adapter = dest_root / f"{args.run_tag}-adapter"

    try:
        import paramiko
    except ImportError:
        print("[error] pip install paramiko", file=sys.stderr)
        return 2

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=args.host, port=args.port, username=args.user, password=password,
                   timeout=30, allow_agent=False, look_for_keys=False)
    try:
        sftp = client.open_sftp()
        try:
            names = {entry.filename for entry in sftp.listdir_attr(remote_adapter)}
        except OSError as exc:
            print(f"[error] cannot list {remote_adapter}: {exc}", file=sys.stderr)
            return 2
        missing = [name for name in REQUIRED if name not in names]
        if missing:
            print(f"[error] {remote_adapter} is not an adapter dir, missing {missing}", file=sys.stderr)
            return 2

        print(f"[fetch] {remote_adapter} -> {local_adapter}", file=sys.stderr)
        fetched = pull(sftp, remote_adapter, local_adapter)
        sftp.close()
    finally:
        client.close()

    total = sum(size for _, size in fetched)
    for name, size in fetched:
        print(f"  {name:32s} {human(size):>10s}", file=sys.stderr)
    print(f"[done] {len(fetched)} files, {human(total)} -> {local_adapter}", file=sys.stderr)
    print(local_adapter)
    return 0


if __name__ == "__main__":
    sys.exit(main())
