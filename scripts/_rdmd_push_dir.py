"""Push a local directory tree to the remote box. Password via env only.

    python scripts/_rdmd_push_dir.py <local_dir> <remote_dir>

Kept as a separate helper (rather than folded into rdmd_remote_put.py) because that one is
deliberately text-only: it decodes utf-8-sig and re-encodes, which would corrupt binaries.
This one is byte-exact and recursive.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import paramiko

from _rdmd_ssh_target import connect as _connect_ssh  # noqa: E402


def connect() -> paramiko.SSHClient:
    # 端点解析只有一处实现（scripts/_rdmd_ssh_target.py）：缺 RDMD_SSH_HOST/PORT
    # 就 fail closed，不再静默回落到另一个实例的端口。
    return _connect_ssh()


def ensure_dir(sftp, remote_dir: str) -> None:
    """mkdir -p 语义。SFTP 的 mkdir 要求父目录已存在，逐级补。"""
    parts = remote_dir.strip("/").split("/")
    current = ""
    for part in parts:
        current = f"{current}/{part}"
        try:
            sftp.stat(current)
        except OSError:
            try:
                sftp.mkdir(current)
            except OSError:
                pass  # raced or already created


# Directories never pushed. The underscore-prefix rule below only applies to files, so a
# directory like __pycache__ would otherwise be recursed into and its .pyc files shipped.
EXCLUDE_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".git", "node_modules"}


def push(sftp, local_dir: Path, remote_dir: str) -> tuple[int, int]:
    ensure_dir(sftp, remote_dir)
    files = 0
    total = 0
    for entry in sorted(local_dir.iterdir(), key=lambda item: item.name):
        remote_path = f"{remote_dir}/{entry.name}"
        if entry.is_dir():
            if entry.name in EXCLUDE_DIRS:
                continue
            sub_files, sub_total = push(sftp, entry, remote_path)
            files += sub_files
            total += sub_total
            continue
        # Skip local scratch/logs so the pushed tree stays exactly the deliverable.
        if entry.name.startswith("_") or entry.suffix == ".log":
            continue
        sftp.put(str(entry), remote_path)
        files += 1
        total += entry.stat().st_size
    return files, total


def rmtree(sftp, remote_dir: str) -> None:
    """递归删除远端目录。部署目标上的陈旧文件是真实风险（旧模块可能遮蔽新模块），
    所以 push 提供 --clean 让目标树与交付物严格一致，而不是只增不删。"""
    try:
        entries = sftp.listdir_attr(remote_dir)
    except OSError:
        return  # already absent
    for entry in entries:
        path = f"{remote_dir}/{entry.filename}"
        if entry.st_mode & 0o040000:
            rmtree(sftp, path)
        else:
            sftp.remove(path)
    try:
        sftp.rmdir(remote_dir)
    except OSError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="push a local directory tree to the remote box")
    parser.add_argument("local_dir")
    parser.add_argument("remote_dir")
    parser.add_argument("--clean", action="store_true",
                        help="先清空远端目录，保证目标树与交付物严格一致（默认只增不删）")
    args = parser.parse_args()

    local_dir = Path(args.local_dir).resolve()
    remote_dir = args.remote_dir.rstrip("/")
    if not local_dir.is_dir():
        raise SystemExit(f"not a directory: {local_dir}")

    client = connect()
    try:
        sftp = client.open_sftp()
        try:
            if args.clean:
                rmtree(sftp, remote_dir)
            files, total = push(sftp, local_dir, remote_dir)
        finally:
            sftp.close()
    finally:
        client.close()
    print(f"pushed {files} files ({total} bytes) -> {remote_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
