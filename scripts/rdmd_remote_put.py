"""Upload a single local file to the remote SeeTa/AutoDL box. Password via env only."""
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
