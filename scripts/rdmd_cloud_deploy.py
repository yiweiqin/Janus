"""把云侧代码（cloud/）部署到 GPU 盒上的 /root/Janus，供云 API 真实起跑。

为什么需要这个脚本 —— 这台盒子上有**两份 Janus**，混淆它们是静默事故：

  /root/autodl-tmp/Janus   ← 训练 bundle 的落点（sft/ 与 deploy/ 在这里，
                             由 rdmd_remote_deploy.py 解压到 /root/autodl-tmp）
  /root/Janus              ← 云 API 的部署点（有 node_modules，从这里起 node）

所以本脚本刻意解压到 `/root`（arcname 是 `Janus/cloud/...`），落在第二份上。
如果照抄训练脚本的 `-C /root/autodl-tmp`，云代码会被放进**没人运行的那份**，
而所有"文件已就位"的检查都会通过 —— 这正是最坏的一类失败。

只做上传与校验，**不迁移、不起进程**：那两步各自是独立的一行命令
（scripts/_rdmd_cloud_migrate.sh / scripts/_rdmd_cloud_start.sh），
分开放才能让失败可归因。
"""
from __future__ import annotations

import hashlib
import os
import sys
import tarfile
from pathlib import Path

import paramiko

from _rdmd_ssh_target import connect as _connect_ssh  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "experiments" / "rdmd_runs" / "rdmd_cloud_bundle.tar.gz"

# 云 API 的部署根。解压时 `-C /root`，arcname 以 `Janus/` 开头 → /root/Janus/cloud/...
REMOTE_PARENT = "/root"
REMOTE_TARGET = f"{REMOTE_PARENT}/Janus/cloud"
REMOTE_TAR = "/root/autodl-tmp/rdmd_cloud_bundle.tar.gz"
REMOTE_BACKUP_DIR = "/root/autodl-tmp/rdmd_runs"

# 只放运行云 API 真正需要的东西。test/ 也带上 —— 盒子上有 node 22，
# 能在目标环境里把 rdmd 测试再跑一遍，比只在开发机上绿更有说服力。
CLOUD_DIRS = ["cloud/src", "cloud/database", "cloud/scripts", "cloud/test"]

# 必须存在于盒子上的本机脚本（harness 需要 import 云侧模块，所以要落到 /root/Janus/scripts/）。
# 它们**不是** cloud/ 的一部分，但验收必须能在目标环境里跑，所以显式列出而不是靠遗忘。
EXTRA_FILES = ["scripts/rdmd_cloud_e2e.mjs", "scripts/_rdmd_worker_provision.mjs"]


def include_paths() -> list[str]:
    """要打进 bundle 的相对路径清单 = cloud 目录 + RDMD 的跨目录依赖闭包。

    第二项是必需的，不是保险：`cloud/src/modules/rdmd/contract.mjs` 刻意 re-export 了
    桌面端的共享契约（`src/shared/contracts/*`），以保证两侧对"什么算合法判定"逐字一致。
    于是云侧有了一个 cloud/ 之外的运行时依赖，而"只同步 cloud/"的部署会启动即崩：
        ERR_MODULE_NOT_FOUND: /root/Janus/src/shared/contracts/uBuddyPlanExec.js
    —— 报错指向一个 cloud/ 里根本不存在、也不该存在的路径，第一眼很难看懂。

    清单不手写，从入口递归跟随相对 import 算出来（scripts/_rdmd_cloud_deps.py）。
    契约的依赖关系变了，这里自动跟着变。
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _rdmd_cloud_deps import outside_cloud  # noqa: PLC0415 - 同目录的本机工具

    return [*CLOUD_DIRS, *EXTRA_FILES, *outside_cloud()]


def connect() -> paramiko.SSHClient:
    # 端点解析只有一处实现（scripts/_rdmd_ssh_target.py）：缺 RDMD_SSH_HOST/PORT
    # 就 fail closed，不再静默回落到另一个实例的端口。
    return _connect_ssh()


def run(client: paramiko.SSHClient, command: str, timeout: int = 300) -> tuple[int, str, str]:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    return stdout.channel.recv_exit_status(), out, err


def build_bundle() -> Path:
    BUNDLE.parent.mkdir(parents=True, exist_ok=True)
    print(f"building {BUNDLE}")
    with tarfile.open(BUNDLE, "w:gz") as tar:
        for rel in include_paths():
            path = ROOT / rel
            if not path.exists():
                raise FileNotFoundError(rel)
            # arcname 必须带 Janus/ 前缀，见模块开头关于"两份 Janus"的说明。
            tar.add(path, arcname=f"Janus/{rel.replace(chr(92), '/')}")
    print(f"bundle_bytes {BUNDLE.stat().st_size}")
    return BUNDLE


def local_hashes() -> dict[str, str]:
    """上传内容 → sha256。远端逐个比对，这是唯一真正回答"部署的是不是我构建的那份"的检查。

    为什么值得这么做：这一层出现过两次假信号 ——
    `grep -c rdmd` 在 server.mjs 上得到 1（因为调用点写作 `registerRdmdRoutes`，
    唯一全小写的 `rdmd` 在 import 路径里），差点被当成"路由没注册"；
    而"文件存在且非空"这种检查在文件被旧版本覆盖时照样全绿。字节比对没有解释空间。
    """
    hashes: dict[str, str] = {}
    for rel in include_paths():
        base = ROOT / rel
        paths = [base] if base.is_file() else sorted(p for p in base.rglob("*") if p.is_file())
        for path in paths:
            relative = path.relative_to(ROOT).as_posix()
            hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def verify_hashes(client: paramiko.SSHClient) -> None:
    expected = local_hashes()
    listing = " ".join(f"{REMOTE_PARENT}/Janus/{rel}" for rel in expected)
    code, out, err = run(client, f"sha256sum {listing}", timeout=300)
    if code != 0:
        raise SystemExit(f"hash_listing_failed:{code}:{err.strip()[:200]}")
    remote = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2:
            continue
        digest, path = parts
        remote[path.replace(f"{REMOTE_PARENT}/Janus/", "", 1)] = digest
    mismatched = [rel for rel, digest in expected.items() if remote.get(rel) != digest]
    missing = [rel for rel in expected if rel not in remote]
    print(f"  hash 比对: {len(expected) - len(mismatched)}/{len(expected)} 一致")
    if missing:
        print(f"  远端缺失: {missing[:5]}")
    if mismatched:
        print(f"  不一致: {mismatched[:5]}")
    if mismatched or missing:
        raise SystemExit("hash_verify_failed: 远端内容与构建产物不一致")


def verify_remote(client: paramiko.SSHClient) -> None:
    verify_hashes(client)
    checks = [
        # rdmd 模块本体。
        (f"{REMOTE_TARGET}/src/modules/rdmd/index.mjs", "rdmd 模块"),
        (f"{REMOTE_TARGET}/src/modules/rdmd/privacy.mjs", "隐私白名单"),
        # 迁移 096 是四层图的前提（放开 depth<=2），097 是作业表，
        # 098 是**作业表的角色授权**。
        #
        # 为什么 098 必须出现在这个清单里：`applyMigrationFiles` 只按文件名记账，
        # 所以在一个**已经上过 097** 的环境上，事后往 097 里补 GRANT 是完全无效的 ——
        # 它永远不会再跑。098 就是那份补票。少了它，症状要到第一次真的入队才出现：
        # 迁移全绿、/readyz 正常，只有 POST /api/rdmd/jobs 抛 permission denied。
        (f"{REMOTE_TARGET}/database/migrations/096_ubuddy_collaboration_graph_agent_step.sql", "迁移 096"),
        (f"{REMOTE_TARGET}/database/migrations/097_rdmd_inference_jobs.sql", "迁移 097"),
        (f"{REMOTE_TARGET}/database/migrations/098_rdmd_inference_jobs_grants.sql", "迁移 098"),
        # 099 是 TPM 原始层的申请/授权表。它和 098 是同一类风险的反面：
        # 098 漏了症状要拖到入队，099 漏了症状要拖到**第一次申请原始层**才出现
        # （而且是在模拟任务群那条链上）—— 都属于"迁移全绿、/readyz 正常"的静默缺口。
        (f"{REMOTE_TARGET}/database/migrations/099_ubuddy_task_public_memory.sql", "迁移 099"),
        # TPM 的 store 接线：迁移建了表，但没有这个模块，表就是死的。
        (f"{REMOTE_TARGET}/src/modules/tpm/index.mjs", "tpm 模块"),
        (f"{REMOTE_TARGET}/scripts/migrate.mjs", "cloud:migrate 入口"),
        # 跨目录依赖：启动路径上第一个会崩的地方（ERR_MODULE_NOT_FOUND）。
        # 单独列出来，是因为它一旦缺失，报错指向 cloud/ 之外的路径，很难一眼归因。
        (f"{REMOTE_PARENT}/Janus/src/shared/contracts/uBuddyPlanExec.js", "共享契约 uBuddyPlanExec"),
        (f"{REMOTE_PARENT}/Janus/src/shared/contracts/uBuddyReverseDetective.js", "共享契约 uBuddyReverseDetective"),
    ]
    failures = []
    for path, label in checks:
        code, out, _ = run(client, f"test -s {path} && echo PRESENT || echo MISSING")
        ok = "PRESENT" in out
        print(f"  {'OK  ' if ok else 'FAIL'} {label}: {path}")
        if not ok:
            failures.append(label)
    # 迁移头必须指到 099，否则 readiness 会认为库没就绪。
    #
    # 098 是纯 GRANT 的迁移，099 是**纯新增表**的迁移 —— 两者 schema 形状的"体量"都很小，
    # 正因如此最容易被漏掉：漏了以后前一条已经在账上、表也在，什么看起来都是好的，
    # 直到真的入队（098）、或真的去申请原始层（099）。
    # 把 readiness 的头推到 099，是让"漏了"在 `/readyz` 上就变红，而不是拖到那条链跑起来。
    code, out, _ = run(client, f"grep -n CLOUD_DATABASE_MIGRATION_HEAD {REMOTE_TARGET}/src/db.mjs | head -1")
    print(f"  migration head on box: {out.strip()}")
    if "099" not in out:
        failures.append("db.mjs 的迁移头不是 099")
    # server.mjs 必须真的**调用**注册函数，否则路由不存在。
    # 这里刻意不用 `grep -c rdmd`：那一行写的是 `registerRdmdRoutes(...)`，
    # 唯一的 `rdmd` 全小写出现在 import 的路径里，大小写敏感计数会得到 1，
    # 看起来像"没注册"。按调用点判，不按计数判。
    code, out, _ = run(client, f"grep -cE 'registerRdmdRoutes\\(' {REMOTE_TARGET}/src/server.mjs || true")
    registrations = int((out.strip() or "0") or 0)
    print(f"  server.mjs 中 registerRdmdRoutes( 调用数: {registrations}")
    if registrations < 1:
        failures.append("server.mjs 未注册 rdmd 路由")
    if failures:
        raise SystemExit(f"verify_failed: {failures}")


def main() -> None:
    client = connect()
    try:
        code, out, err = run(client, f"mkdir -p {REMOTE_BACKUP_DIR} && node --version 2>/dev/null || true")
        print(f"remote node: {out.strip() or '(默认 PATH 无 node，稍后用 nvm 的绝对路径)'}")

        # 覆盖前先备份。这份 /root/Janus 不是 git 仓库，没有第二份副本 ——
        # 备份失败就必须停，不能"先覆盖了再说"。
        backup_cmd = (
            f"if [ -d {REMOTE_TARGET} ]; then "
            f"TS=$(date +%Y%m%d_%H%M%S); "
            f"BACKUP={REMOTE_BACKUP_DIR}/cloud_backup_$TS.tar.gz; "
            f"cd {REMOTE_PARENT}/Janus && tar -czf \"$BACKUP\" cloud && du -h \"$BACKUP\" && echo BACKED_UP $BACKUP; "
            f"else echo NO_EXISTING_CLOUD; fi"
        )
        code, out, err = run(client, backup_cmd, timeout=900)
        print(out.strip())
        if err.strip():
            print(err.strip())
        if code != 0 or ("BACKED_UP" not in out and "NO_EXISTING_CLOUD" not in out):
            raise SystemExit("cloud_backup_failed: refusing to overwrite the remote cloud dir")

        build_bundle()
        outside = [rel for rel in include_paths() if not rel.startswith("cloud/")]
        print(f"随部署一起上传的 cloud/ 之外的依赖（{len(outside)} 个）:")
        for rel in outside:
            print(f"  {rel}")
        sftp = client.open_sftp()
        try:
            print(f"uploading {BUNDLE} -> {REMOTE_TAR}")

            def cb(transferred: int, total: int) -> None:
                if total and transferred == total:
                    print(f"upload {transferred}/{total}")

            sftp.put(str(BUNDLE), REMOTE_TAR, callback=cb)
        finally:
            sftp.close()

        # -C /root（不是 /root/autodl-tmp），见模块开头。
        code, out, err = run(
            client,
            f"tar -xzf {REMOTE_TAR} -C {REMOTE_PARENT} && ls -1 {REMOTE_TARGET}",
            timeout=600,
        )
        print(out)
        if err.strip():
            print(err.strip())
        if code != 0:
            raise SystemExit(f"extract_failed:{code}")

        print("--- verify ---")
        verify_remote(client)
        print("cloud_deploy_ok")
    finally:
        client.close()


if __name__ == "__main__":
    main()
