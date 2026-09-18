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


def connect() -> paramiko.SSHClient:
    password = os.environ.get("RDMD_SSH_PASSWORD") or os.environ.get("SSH_PASSWORD")
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
