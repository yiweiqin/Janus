"""一条命令在盒子上跑完模拟任务群的闭环，并把报告拉回来。

    python scripts/sim_remote_run.py --adapter /root/autodl-tmp/rdmd_runs/qlora-v4/adapter

零人工：stage → 上传 → 盒子上跑 `run_remote.sh` → 拉回报告。可重跑。
（"可重跑"的准确含义见 `experiments/sim_task_group/run_remote.sh` 的文件头：
会新增作业行，但管线与结论都可复现。）

为什么本机要有这一步，而不是直接 SSH 一条命令：bundle 必须**先算出来再传**。
仓库本地 3.6 GB（`experiments` 2.4 GB 是权重与产物），全量上传不可行，
所以本地先走一次 import 闭包把真正需要的 33 个文件挑出来（见 `_sim_stage.mjs`），
顺带在 stage 目录里跑一遍冒烟 —— 漏文件的失败留在本机，不要带到盒子上。
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))
import _rdmd_ssh_target as ssh_target  # noqa: E402

REMOTE_SIM_RUN_DIR = "/root/autodl-tmp/sim_run"
REMOTE_SIM_ROOT = f"{REMOTE_SIM_RUN_DIR}/Janus"
REMOTE_TAR = f"{REMOTE_SIM_RUN_DIR}/sim_bundle.tar.gz"
REMOTE_REPORT_TAR = f"{REMOTE_SIM_RUN_DIR}/sim_out.tar.gz"
LOCAL_REPORT_DIR = ROOT / "experiments" / "sim_task_group" / "out" / "remote"


def stage_bundle() -> tuple[Path, Path]:
    """算闭包 → 落 stage → 打包。返回 (tar 路径, stage 目录)。"""
    stage_dir = ROOT / "experiments" / "sim_task_group" / ".bundle"
    result = subprocess.run(
        ["node", "scripts/_sim_stage.mjs", "--out", str(stage_dir)],
        cwd=str(ROOT),
        capture_output=True,
        # 本机是 Windows，Python 默认按 GBK 解 node 的 UTF-8 输出，中文会炸成
        # UnicodeDecodeError（`_readerthread` 里，堆栈看着像 node 挂了）。
        encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise SystemExit(f"stage 失败：\n{result.stdout}{result.stderr}")
    # 只回显最后一行（文件清单太长）。
    tail = [line for line in result.stdout.splitlines() if line.strip()][-1:]
    print("\n".join(tail))

    tar_path = ROOT / "experiments" / "sim_task_group" / ".bundle.tar.gz"
    with tarfile.open(tar_path, "w:gz") as tar:
        # arcname='.' → 解压后就是 SIM_ROOT 本身，不套一层。
        tar.add(stage_dir, arcname=".")
    print(f"bundle {tar_path.stat().st_size / 1024:.0f} KB -> {tar_path}")
    return tar_path, stage_dir


def upload(client, local: Path, remote: str) -> None:
    # 目录可能不存在（第一次跑），先建。
    _, _, _ = _exec(client, f"mkdir -p {os.path.dirname(remote)}")
    with client.open_sftp() as sftp:
        sftp.put(str(local), remote)
    _, out, _ = _exec(client, f"stat -c%s {remote}")
    print(f"uploaded {local.name} -> {remote} ({out.strip()} bytes)")


def download(client, remote: str, local: Path) -> None:
    local.parent.mkdir(parents=True, exist_ok=True)
    with client.open_sftp() as sftp:
        sftp.get(remote, str(local))
    print(f"downloaded {remote} -> {local} ({local.stat().st_size} bytes)")


def _exec(client, command: str, timeout: int = 600) -> tuple[int, str, str]:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    del stdin
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    return stdout.channel.recv_exit_status(), out, err


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", default="offline", choices=["offline", "llm"])
    parser.add_argument("--limit", default="0")
    parser.add_argument("--adapter", default=os.environ.get("RDMD_ADAPTER", ""))
    parser.add_argument("--skip-worker", action="store_true",
                        help="不跑 GPU worker，走 null 后端（只验证链路，判定恒为 UNKNOWN）")
    parser.add_argument("--submit-dry", action="store_true", help="只做本地审计与批次规划，不写库不提交")
    parser.add_argument("--keep-bundle", action="store_true")
    # 盒子上那一趟要跑多久，由**批次规模**决定，不是一个常量：collect 逐条轮询到终态，
    # 实测吞吐约 3.5–4.5 条/分钟（单卡、v4 adapter）。原来写死的 3600s 只够 ~250 条，
    # 而默认（不限量）批次是 1314 条 —— 超时的症状是"SSH 断开、报告被拉回一半"，
    # 看起来像盒子挂了。所以做成参数，默认给足 6 小时。
    parser.add_argument("--timeout", type=int,
                        default=int(os.environ.get("SIM_REMOTE_TIMEOUT", "21600")),
                        help="盒子上 run_remote.sh 的等待秒数（默认 6h，按批次规模调）")
    args = parser.parse_args()

    if not args.skip_worker and not args.adapter:
        # `_rdmd_worker_daemon.sh` 自己就拒绝给 adapter 设默认值（那个默认值会让
        # v4 静默退化成 v3）。这里跟着一起拒绝，把"跑错权重"挡在开跑之前。
        raise SystemExit(
            "--adapter 是必须的（或显式 --skip-worker）。\n"
            "  盒子上可选的 adapter：ls -d /root/autodl-tmp/rdmd_runs/qlora-*/adapter"
        )

    tar_path, _ = stage_bundle()
    client = ssh_target.connect()
    try:
        upload(client, tar_path, REMOTE_TAR)
        print("解压 + 挂 node_modules …")
        code, out, err = _exec(
            client,
            f"set -e; mkdir -p {REMOTE_SIM_ROOT}; "
            f"tar -xzf {REMOTE_TAR} -C {REMOTE_SIM_ROOT}; "
            # bundle 不带 node_modules（3.6 GB 传不动）。盒子上已有的那个挂进来 ——
            # 用 -n 保证重跑时不会把一个真实目录覆盖掉。
            f"ln -sfn /root/Janus/node_modules {REMOTE_SIM_ROOT}/node_modules; "
            f"ls -1 {REMOTE_SIM_ROOT} | head -20",
        )
        print(out)
        if code != 0:
            raise SystemExit(f"解压失败：{err}")

        env_exports = " ".join([
            f"SIM_MODE={args.mode}",
            f"SIM_LIMIT={args.limit}",
            f"SIM_SUBMIT_DRY={1 if args.submit_dry else 0}",
            f"SIM_SKIP_WORKER={1 if args.skip_worker else 0}",
            f"RDMD_ADAPTER={args.adapter}",
        ])
        print(f"\n########## 在盒子上跑闭环（{env_exports}，等待上限 {args.timeout}s）##########")
        code, out, err = _exec(
            client,
            f"cd {REMOTE_SIM_ROOT}/experiments/sim_task_group && "
            f"env {env_exports} bash run_remote.sh",
            timeout=args.timeout,
        )
        sys.stdout.write(out)
        if err:
            sys.stderr.write(err)
        # 把盒子上的整段输出留在本地。失败时唯一的证据就是这段输出 ——
        # 而它只在控制台里的话，控制台一滚就没了；"为什么失败"就又变成靠猜。
        LOCAL_REPORT_DIR.mkdir(parents=True, exist_ok=True)
        (LOCAL_REPORT_DIR / "run_remote.stdout.log").write_text(out, encoding="utf-8")
        (LOCAL_REPORT_DIR / "run_remote.stderr.log").write_text(err, encoding="utf-8")

        if code != 0:
            # 失败也要尽量把已经产生的报告拉回来 —— 否则"为什么失败"只能靠猜。
            print(f"\n[警告] 远端脚本退出码 {code}；仍尝试拉回已有的 out/。")
        # 不看输出里有没有打印过 SIM_REPORT_TAR=，直接问文件在不在。
        # 解析输出判断"第 8 步跑没跑过"在脚本被改过之后就会失效。
        _, exists_out, _ = _exec(client, f"test -f {REMOTE_REPORT_TAR} && echo yes || echo no")
        if exists_out.strip() != "yes":
            _, pack_out, _ = _exec(
                client,
                f"tar -czf {REMOTE_REPORT_TAR} -C {REMOTE_SIM_ROOT}/experiments/sim_task_group out "
                f"&& echo packed || echo nopack",
            )
            print(f"远端没留下报告包 → 手工打一次已经生成的 out/：{pack_out.strip()}")
        download(client, REMOTE_REPORT_TAR, LOCAL_REPORT_DIR / "sim_out.tar.gz")
    finally:
        client.close()

    with tarfile.open(LOCAL_REPORT_DIR / "sim_out.tar.gz") as tar:
        tar.extractall(LOCAL_REPORT_DIR)
    print(f"\n报告解到 {LOCAL_REPORT_DIR / 'out'}")
    if not args.keep_bundle:
        tar_path.unlink(missing_ok=True)
    report = LOCAL_REPORT_DIR / "out" / "collect_report.json"
    if report.exists():
        print(f"看这一份：{report}")
    if code != 0:
        raise SystemExit(code)


if __name__ == "__main__":
    main()
