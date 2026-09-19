"""Upload RDMD training bundle and start QLoRA on the remote SeeTa/AutoDL box."""
from __future__ import annotations

import json
import os
import tarfile
import time
from pathlib import Path

import paramiko

from _rdmd_ssh_target import connect as _connect_ssh  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "experiments" / "rdmd_runs" / "rdmd_train_bundle.tar.gz"
REMOTE_ROOT = "/root/autodl-tmp"
REMOTE_TAR = f"{REMOTE_ROOT}/rdmd_train_bundle.tar.gz"


INCLUDE = [
    "scripts/train_qlora_rdmd.py",
    "scripts/tdb_completion.py",
    "scripts/eval_rdmd_qlora.py",
    "experiments/rdmd_detective_dataset/qlora_config.json",
    "experiments/rdmd_detective_dataset/check_readiness.py",
    "experiments/rdmd_detective_dataset/requirements-train.txt",
    "experiments/rdmd_detective_dataset/TRAINING_RUNBOOK.zh-CN.md",
    "experiments/rdmd_detective_dataset/sft",
    # P4: 云侧推理的 worker 要在盒子上跑 predict.py。这两个文件互为依赖
    # （predict.py 把自身目录插进 sys.path 后 import rdmd_detective），必须成对上传，
    # 漏一个就会在推理时才炸。
    "experiments/rdmd_detective_dataset/deploy/predict.py",
    "experiments/rdmd_detective_dataset/deploy/rdmd_detective.py",
    # worker 自己也要在盒子上：它领活 → 跑 predict.py → 回传判定。
    "scripts/rdmd_gpu_worker.py",
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


def build_bundle() -> Path:
    BUNDLE.parent.mkdir(parents=True, exist_ok=True)
    print(f"building {BUNDLE}")
    with tarfile.open(BUNDLE, "w:gz") as tar:
        for rel in INCLUDE:
            path = ROOT / rel
            if not path.exists():
                raise FileNotFoundError(rel)
            tar.add(path, arcname=f"Janus/{rel.replace(chr(92), '/')}")
    print(f"bundle_bytes {BUNDLE.stat().st_size}")
    return BUNDLE


def sftp_put(client: paramiko.SSHClient, local: Path, remote: str) -> None:
    sftp = client.open_sftp()
    try:
        def cb(transferred: int, total: int) -> None:
            if total and transferred == total or transferred % (32 * 1024 * 1024) < 1024 * 1024:
                print(f"upload {transferred}/{total}")

        print(f"uploading {local} -> {remote}")
        sftp.put(str(local), remote, callback=cb)
    finally:
        sftp.close()


def main() -> None:
    stage = os.environ.get("RDMD_DEPLOY_STAGE", "all")
    client = connect()
    try:
        if stage in ("all", "upload"):
            build_bundle()
            code, out, err = run(client, f"mkdir -p {REMOTE_ROOT}/rdmd_runs {REMOTE_ROOT}/hf {REMOTE_ROOT}/models")
            if code != 0:
                raise SystemExit(err or out)
            # Safety: the incoming bundle overwrites the remote SFT dir. The previous dataset
            # may be the only remaining copy (see V3_SMOKE_REPORT), so archive it first, and
            # refuse to continue if the archive did not succeed.
            # NOTE: `$(date ...)` must be expanded exactly once, inside one remote shell. If the
            # substitution is interpolated into several places the name can differ by a second,
            # and the verification step then looks for a file that was never written.
            remote_sft_parent = f"{REMOTE_ROOT}/Janus/experiments/rdmd_detective_dataset"
            backup_cmd = (
                f"if [ -d {remote_sft_parent}/sft ]; then "
                f"TS=$(date +%Y%m%d_%H%M%S); "
                f"BACKUP={REMOTE_ROOT}/rdmd_runs/sft_backup_$TS.tar.gz; "
                f"cd {remote_sft_parent} && tar -czf \"$BACKUP\" sft && du -h \"$BACKUP\" && echo BACKED_UP $BACKUP; "
                f"else echo NO_EXISTING_SFT; fi"
            )
            code, out, err = run(client, backup_cmd, timeout=600)
            print(out.strip())
            if err.strip():
                print(err.strip())
            if code != 0 or ("BACKED_UP" not in out and "NO_EXISTING_SFT" not in out):
                raise SystemExit("sft_backup_failed: refusing to overwrite the remote SFT dir")
            sftp_put(client, BUNDLE, REMOTE_TAR)
            code, out, err = run(
                client,
                f"mkdir -p {REMOTE_ROOT}/Janus && tar -xzf {REMOTE_TAR} -C {REMOTE_ROOT} && ls -lh {REMOTE_ROOT}/Janus/experiments/rdmd_detective_dataset/sft",
                timeout=180,
            )
            print(out)
            if err:
                print(err)
            if code != 0:
                raise SystemExit(f"extract_failed:{code}")
        if stage in ("all", "bootstrap", "train"):
            script = Path(__file__).with_name("_rdmd_remote_bootstrap.sh").read_text(encoding="utf-8-sig")
            # The bootstrap is streamed over stdin, so local env vars are not inherited; forward
            # the run tag explicitly so v3 lands in its own output dir.
            run_tag = os.environ.get("RDMD_RUN_TAG", "").strip()
            if run_tag:
                script = f"export RDMD_RUN_TAG={run_tag}\n{script}"
                print(f"run_tag {run_tag}")
            stdin, stdout, stderr = client.exec_command("bash -s", timeout=int(os.environ.get("RDMD_BOOTSTRAP_TIMEOUT", "3600")))
            stdin.write(script)
            stdin.channel.shutdown_write()
            while not stdout.channel.exit_status_ready():
                if stdout.channel.recv_ready():
                    print(stdout.channel.recv(65536).decode("utf-8", errors="replace"), end="")
                if stderr.channel.recv_stderr_ready():
                    print(stderr.channel.recv_stderr(65536).decode("utf-8", errors="replace"), end="")
                time.sleep(1)
            print(stdout.read().decode("utf-8", errors="replace"), end="")
            err = stderr.read().decode("utf-8", errors="replace")
            if err:
                print(err, end="")
            code = stdout.channel.recv_exit_status()
            print(json.dumps({"bootstrap_exit": code}))
            if code != 0:
                raise SystemExit(code)
    finally:
        client.close()


if __name__ == "__main__":
    main()
