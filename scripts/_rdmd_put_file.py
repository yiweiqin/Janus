"""Binary-safe single-file upload. Password via env only.

Unlike rdmd_remote_put.py (deliberately text-only: it decodes utf-8-sig and re-encodes),
this one does a byte-exact SFTP put, so it is safe for tarballs and any other binary.
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


def main() -> int:
    parser = argparse.ArgumentParser(description="byte-exact put of one local file to the remote box")
    parser.add_argument("local_file")
    parser.add_argument("remote_path")
    args = parser.parse_args()

    local = Path(args.local_file).resolve()
    if not local.is_file():
        raise SystemExit(f"not a file: {local}")
    size = local.stat().st_size

    client = connect()
    try:
        sftp = client.open_sftp()
        try:
            sftp.put(str(local), args.remote_path)
            remote_size = sftp.stat(args.remote_path).st_size
        finally:
            sftp.close()
    finally:
        client.close()

    print(f"local_bytes={size} remote_bytes={remote_size} -> {args.remote_path}")
    if size != remote_size:
        print("[error] size mismatch", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
