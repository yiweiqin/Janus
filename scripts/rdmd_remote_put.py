"""Upload a single local file to the remote SeeTa/AutoDL box. Password via env only."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import paramiko

from _rdmd_ssh_target import connect as _connect_ssh  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def connect() -> paramiko.SSHClient:
    # 端点解析只有一处实现（scripts/_rdmd_ssh_target.py）：缺 RDMD_SSH_HOST/PORT
    # 就 fail closed，不再静默回落到另一个实例的端口。
    return _connect_ssh()


def main() -> None:
    # usage: python scripts/rdmd_remote_put.py <local_rel> [remote_rel ...]
    if len(sys.argv) < 3:
        raise SystemExit("usage: rdmd_remote_put.py <local_rel> <remote_rel> [more pairs...]")
    pairs = list(zip(sys.argv[1::2], sys.argv[2::2]))
    client = connect()
    try:
        sftp = client.open_sftp()
        try:
            for local_rel, remote_rel in pairs:
                local = ROOT / local_rel
                remote = f"/root/autodl-tmp/Janus/{remote_rel}"
                data = local.read_bytes().decode("utf-8-sig").encode("utf-8")
                with sftp.open(remote, "wb") as handle:
                    handle.write(data)
                print(f"put {local} -> {remote} ({len(data)} bytes)")
        finally:
            sftp.close()
    finally:
        client.close()


if __name__ == "__main__":
    main()
