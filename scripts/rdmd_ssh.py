"""One-shot SeeTaCloud SSH helper. Password via env, never written to the repo."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import paramiko


def connect(host: str, port: int, user: str, password: str, timeout: int = 30) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=host, port=port, username=user, password=password, timeout=timeout, allow_agent=False, look_for_keys=False)
    return client


def run(client: paramiko.SSHClient, command: str, timeout: int = 120, stdin_data: str | None = None) -> tuple[int, str, str]:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    if stdin_data is not None:
        stdin.write(stdin_data)
        stdin.channel.shutdown_write()
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("RDMD_SSH_HOST", "connect.bjb1.seetacloud.com"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("RDMD_SSH_PORT", "53957")))
    parser.add_argument("--user", default=os.environ.get("RDMD_SSH_USER", "root"))
    parser.add_argument("--command", default="")
    parser.add_argument("--command-file", default="")
    parser.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                        help="export KEY=VALUE before the script; repeatable. Works with --command-file.")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    password = os.environ.get("RDMD_SSH_PASSWORD") or os.environ.get("SSH_PASSWORD")
    if not password:
        raise SystemExit("RDMD_SSH_PASSWORD is required")
    if args.command_file:
        # utf-8-sig: tolerate scripts written on Windows with a BOM, which bash otherwise chokes on.
        stdin_data = Path(args.command_file).read_text(encoding="utf-8-sig")
        if args.set:
            stdin_data = "".join(f"export {item}\n" for item in args.set) + stdin_data
        command = "bash -s"
    else:
        stdin_data = None
        command = args.command
        if args.set:
            command = " && ".join([*(f"export {item}" for item in args.set), command])
    if not command.strip():
        raise SystemExit("command_required")
    client = connect(args.host, args.port, args.user, password)
    try:
        code, out, err = run(client, command, timeout=args.timeout, stdin_data=stdin_data)
        sys.stdout.write(out)
        if err:
            sys.stderr.write(err)
        raise SystemExit(code)
    finally:
        client.close()


if __name__ == "__main__":
    main()
