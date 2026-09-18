"""Download one or more single files from the remote SeeTa/AutoDL box. Password via env only.

Symmetric with rdmd_remote_put.py, which had no counterpart: put maps a repo-relative path onto
/root/autodl-tmp/Janus/, get takes an absolute remote path and a repo-relative destination.

usage: python scripts/rdmd_remote_get.py <remote_abs> <local_rel> [<remote_abs> <local_rel> ...]
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]


def connect() -> paramiko.SSHClient:
    password = os.environ.get("RDMD_SSH_PASSWORD")
    if not password:
        raise SystemExit("RDMD_SSH_PASSWORD is required")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=os.environ.get("RDMD_SSH_HOST", "connect.bjb1.seetacloud.com"),
        port=int(os.environ.get("RDMD_SSH_PORT", "53957")),
        username=os.environ.get("RDMD_SSH_USER", "root"),
        password=password,
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def main() -> None:
    if len(sys.argv) < 3 or len(sys.argv[1:]) % 2:
        raise SystemExit("usage: rdmd_remote_get.py <remote_abs> <local_rel> [more pairs...]")
    pairs = list(zip(sys.argv[1::2], sys.argv[2::2]))
    client = connect()
    try:
        sftp = client.open_sftp()
        try:
            for remote_abs, local_rel in pairs:
                local = ROOT / local_rel
                local.parent.mkdir(parents=True, exist_ok=True)
                with sftp.open(remote_abs, "rb") as handle:
                    data = handle.read()
                local.write_bytes(data)
                print(f"get {remote_abs} -> {local} ({len(data)} bytes)")
        finally:
            sftp.close()
    finally:
        client.close()


if __name__ == "__main__":
    main()
