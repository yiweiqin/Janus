"""One-shot SeeTaCloud SSH helper. Password via env, never written to the repo."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import paramiko

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _rdmd_ssh_target as ssh_target  # noqa: E402


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
    parser.add_argument("--host", default=os.environ.get("RDMD_SSH_HOST", ""))
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--user", default=os.environ.get("RDMD_SSH_USER", "root") or "root")
    parser.add_argument("--command", default="")
    parser.add_argument("--command-file", default="")
    parser.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                        help="export KEY=VALUE before the script; repeatable. Works with --command-file.")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    # 端点解析只有一处实现。缺 host/port 就 fail closed ——
    # 这里曾经有个 `"53957"` 回落值，那是另一个实例的端口，
    # 于是"忘了 source 环境变量"会被伪装成"盒子连不上"。
    target = ssh_target.target_from_env()
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
    # 显式传参（`--host/--port/--user`）优先；没传就用环境里的那一份。
    host = args.host or target["hostname"]
    port = args.port or target["port"]
    user = args.user or target["username"]
    if port != target["port"] and args.port:
        # 显式换端口时不带默认口令去连 —— 那多半是连错实例了。
        print(f"[rdmd_ssh] 注意：显式端口 {port} 与环境里的 {target['port']} 不同", file=sys.stderr)
    client = connect(host, port, user, target["password"])
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
