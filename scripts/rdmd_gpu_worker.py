"""RDMD GPU 盒出站 worker：领活 → 跑 predict.py → 回传判定。

拓扑（P0 实测）：云 API 与 GPU 盒**是同一台 AutoDL 实例**，云 API 监听 127.0.0.1:8787。
所以本 worker 连的是 `http://127.0.0.1:8787`，AutoDL 不需要开任何入站端口、不需要隧道。
即使将来云 API 挪到另一台机器，本脚本的形态也不用变：它**只发出站 HTTPS**，
与 `cloud_evolution_jobs` 的抢占模式同构。

用法：

    # 一次性把队列里的活干完就退出（部署验证用）
    python rdmd_gpu_worker.py --once

    # 常驻
    RDMD_DEVICE_GRANT=dgr_xxx python rdmd_gpu_worker.py

必需的环境变量：

    RDMD_DEVICE_GRANT   带 `rdmd:infer` scope 的 device grant（`dgr_...`）。
                        它只能领活与回传判定，**没有任何读用户数据的权力**。
    RDMD_ADAPTER        LoRA adapter 目录（例如 /root/autodl-tmp/rdmd_runs/qlora-v3）
    RDMD_BASE_MODEL     基座模型目录（例如 /root/autodl-tmp/Qwen3-8B）

可选：RDMD_CLOUD_API（默认 http://127.0.0.1:8787）、RDMD_WORKER_ID、
RDMD_PYTHON（默认 /root/autodl-tmp/rdmd-env/bin/python）、RDMD_DEVICE（默认 cuda:0）、
RDMD_POLL_SECONDS（默认 10）、RDMD_BATCH（默认 1，上限 4）、RDMD_MAX_NEW_TOKENS（默认 160）、
RDMD_CONTRACT_DIR（deploy/ 所在目录，默认按本脚本位置推断）。

---------------------------------------------------------------------------
三条不许妥协的规矩
---------------------------------------------------------------------------

1. **出处不许自证**：判定必须带 adapter sha256、base model id、契约版本、规则版本。
   contract/rule 版本从**云侧的领活响应**里拿，不在这里另写一份 —— 云侧照单全收一个
   worker 自己声明的版本，等于出处由被审计方填写。worker 拿本地 `rdmd_detective.CONTRACT_VERSION`
   与云侧下发的版本比对，**不一致就不产出判定**（退出非零，让人来看）。

2. **不发判定比发假判定好**：predict.py 退出码 2 = 输入/环境错误。这时**什么都不回传**，
   作业留在 claimed 状态，租约（15 分钟）到期后会被重新领取。回一条 UNKNOWN 会把
   "环境坏了"伪装成"模型弃权"，而这两种情况的修法完全不同。

3. **单条失败不得中断整批**：一整轮里某一个作业炸了，其余作业照旧处理完。
   否则一个坏 case 就能让整个队列停在原地。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

WORKER_VERSION = "rdmd-gpu-worker/1"
HTTP_TIMEOUT_SECONDS = 30
PREDICT_TIMEOUT_SECONDS = 600


def env(name: str, default: str = "") -> str:
    return str(os.environ.get(name, default) or "").strip()


def log(message: str) -> None:
    print(f"[rdmd-worker] {message}", flush=True)


class CloudError(RuntimeError):
    """云侧拒绝（4xx/5xx）。带上状态码与响应体，否则排查时只知道"失败了"。"""

    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"cloud returned {status}: {body[:300]}")
        self.status = status
        self.body = body


def api(cloud_api: str, token: str, path: str, payload: dict | None = None) -> dict:
    """一次出站调用。`payload=None` 表示 GET。"""
    url = cloud_api.rstrip("/") + path
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="GET" if data is None else "POST")
    request.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        raise CloudError(error.code, error.read().decode("utf-8", "replace")) from error


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def adapter_sha256(adapter_dir: str) -> str:
    """adapter 的 64 位十六进制摘要。**不许返回占位符。**

    取权重的字节哈希（`adapter_model.safetensors`，没有就退到 `adapter_config.json`）。
    云侧要求正好 64 位 hex 就是为了让 `'unknown'` 这种占位符过不去 —— 见
    `normalizeProvenance` 的注释：不可审计的判定等于没有判定。
    """
    directory = Path(adapter_dir)
    for name in ("adapter_model.safetensors", "adapter_model.bin", "adapter_config.json"):
        candidate = directory / name
        if candidate.is_file():
            return sha256_file(candidate)
    raise SystemExit(f"[error] no adapter weight/config found under {adapter_dir}; refusing to run")


def resolve_contract_version(deploy_dir: Path) -> str:
    """本 worker 所遵循的契约版本，取自**要跑的那份** rdmd_detective.py（而不是另写一份）。"""
    sys.path.insert(0, str(deploy_dir))
    import rdmd_detective  # noqa: PLC0415 - 路径要先插进去才能 import

    return str(rdmd_detective.CONTRACT_VERSION)


def run_predict(*, python: str, predict_py: Path, case: dict, adapter: str, model: str,
                device: str, max_new_tokens: int) -> tuple[int, list[dict], str]:
    """在临时目录里跑一条 case。返回 (退出码, 判定记录列表, stderr 尾部)。"""
    with tempfile.TemporaryDirectory(prefix="rdmd-worker-") as work:
        case_path = Path(work) / "case.json"
        out_path = Path(work) / "verdict.jsonl"
        case_path.write_text(json.dumps(case, ensure_ascii=False), encoding="utf-8")
        command = [
            python, str(predict_py),
            "--input", str(case_path), "--output", str(out_path),
            "--adapter", adapter, "--model", model, "--device", device,
            "--max-new-tokens", str(max_new_tokens),
        ]
        completed = subprocess.run(  # noqa: S603 - 命令全由本脚本拼装，无外部输入
            command, capture_output=True, text=True, timeout=PREDICT_TIMEOUT_SECONDS, check=False,
        )
        records: list[dict] = []
        if out_path.is_file():
            for line in out_path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    records.append(json.loads(line))
        return completed.returncode, records, (completed.stderr or "")[-2000:]


def verdict_from_record(record: dict) -> dict:
    """predict.py 的一条记录 → 云侧 verdict。

    status 归一：predict.py 的 `_blank()` 产出 `status=UNKNOWN`，所以契约违规/推理失败
    的记录天然就是 UNKNOWN，不需要在这里编一个。

    **`valid=False` 一律降级成弃权（UNKNOWN + reason），绝不原样回传。** 这不是洁癖，
    是在真机 E2E 上撞出来的：模型对一条真 case 回了
    `{"status":"drift","nodeId":"n_step","type":""}` —— 节点指对了，说不出漂移类型 ——
    predict.py 判 `drift_without_type`，原样回传被云侧 400
    `rdmd_verdict_incomplete`。三条理由说明为什么必须在这里降级而不是原样发：

    1. 形状上必然失败：云侧 `normalizeVerdict` 要求 drift 的 nodeId 与 type 都非空，
       而"说 drift 但给不出 type"是**评分里最高频的一类 invalid**（模型认得差异、
       说不出归类）。原样发等于把一个语义问题伪造成一次 HTTP 失败。
    2. 400 不落终态：作业退回 claimed、下次再领，而重试跑的是同一个 case、同一份权重，
       结果一模一样 —— 用尽 max_attempts 之后既领不到也结不掉，变成僵尸行
       （见云侧 `claimOne` 的收尾逻辑）。
    3. 语义上它本来就是弃权：`valid=False` 的含义是"这条判定自不自洽都没保证"，
       不是"一个略有瑕疵但可用的指认"。UNKNOWN 在产品里已是一等公民（null 后端恒定
       产出它），桌面端对它的处理是 record_only + reason。

    模型原本想指认谁不会丢：进 `warnings`（`unusable_claim:node/type`），审计时要看
    "它当时指向哪里"仍有据可查。**不替模型补 type** —— 那是编造一个它没给出的归类。
    """
    raw_verdict = record.get("verdict") or {}
    status = str(raw_verdict.get("status") or "UNKNOWN")
    if status not in ("drift", "no_drift", "UNKNOWN"):
        # 不该发生：predict.py 的 parse_completion 已经归一过。真发生了就弃权，
        # 而不是把未知状态塞给云侧（那会被 400 掉，把一个语义问题变成一次重试）。
        status = "UNKNOWN"
    warnings = [str(item)[:200] for item in (record.get("warnings") or [])][:20]
    valid = record.get("valid") is True

    claimed_node = str(raw_verdict.get("nodeId") or "")[:200]
    claimed_type = str(raw_verdict.get("type") or "")[:60]

    if not valid:
        # 原因必须能指认修法：契约违规要去补字段，推理失败要去查环境。
        reason = warnings[0] if warnings else "invalid_verdict"
        if claimed_node or claimed_type:
            # UNKNOWN 必须完全弃权（Python 侧 validate_verdict 与云侧对 UNKNOWN 同义），
            # 所以 nodeId/type 清空，只把"它当时指向哪里"留在 warnings 里。
            warnings.append(f"unusable_claim:{claimed_node or '-'}/{claimed_type or '-'}"[:200])
        return {
            "status": "UNKNOWN",
            "nodeId": "",
            "type": "",
            "valid": False,
            "warnings": warnings[:20],
            "reason": reason[:200],
        }

    # 走到这里 valid=True，形状已被 validate_verdict 保证（drift 必带 nodeId+type，
    # no_drift/UNKNOWN 必不带）。
    return {
        "status": status,
        "nodeId": claimed_node,
        "type": claimed_type if status == "drift" else "",
        "valid": True,
        "warnings": warnings,
        "reason": "model_unknown" if status == "UNKNOWN" else "",
    }


def process_job(*, job: dict, config: dict, predict_py: Path, adapter_sha: str) -> None:
    job_id = job.get("jobId")
    try:
        case = job.get("case") or {}
        if not case.get("G_star") or not case.get("G_prime"):
            # 载荷被裁空或格式不对。**不发判定**：这是链路问题，不是模型弃权。
            log(f"[error] job {job_id} has no G_star/G_prime; refusing to return a verdict")
            return
        code, records, stderr_tail = run_predict(
            python=config["python"], predict_py=predict_py, case=case, adapter=config["adapter"],
            model=config["model"], device=config["device"], max_new_tokens=config["max_new_tokens"],
        )
        if code == 2:
            log(f"[error] job {job_id} predict.py exited 2 (input/environment error); "
                f"NOT returning a verdict so the lease can re-queue it\n{stderr_tail}")
            return
        if not records:
            log(f"[error] job {job_id} produced no verdict record (exit {code})\n{stderr_tail}")
            return
        verdict = verdict_from_record(records[0])
        api(config["cloud_api"], config["token"], f"/api/rdmd/jobs/{job_id}/verdict", {
            "verdict": verdict,
            "provenance": {
                "adapterSha256": adapter_sha,
                "baseModelId": config["base_model_id"],
                "contractVersion": config["contract_version"],
                "ruleVersion": config["rule_version"],
                "workerVersion": WORKER_VERSION,
            },
        })
        log(f"[ok] job {job_id} -> {verdict['status']}"
            f"{' ' + verdict['nodeId'] if verdict['nodeId'] else ''}"
            f"{' (' + verdict['reason'] + ')' if verdict['reason'] else ''}")
    except CloudError as error:
        # 409 = 出处被拒或作业状态不对；401 = grant 失效。两种都要人来看。
        log(f"[error] job {job_id} verdict rejected: {error}")
    except subprocess.TimeoutExpired:
        log(f"[error] job {job_id} predict.py exceeded {PREDICT_TIMEOUT_SECONDS}s")
    except Exception as error:  # noqa: BLE001 - 单条不许拖垮整轮
        log(f"[error] job {job_id} failed: {type(error).__name__}: {error}")


def main() -> int:
    parser = argparse.ArgumentParser(description="RDMD GPU worker (outbound pull)")
    parser.add_argument("--once", action="store_true", help="跑一轮就退出（部署验证用）")
    args = parser.parse_args()

    deploy_dir = Path(env("RDMD_CONTRACT_DIR") or Path(__file__).resolve().parents[1]
                      / "experiments" / "rdmd_detective_dataset" / "deploy")
    predict_py = deploy_dir / "predict.py"
    if not predict_py.is_file():
        raise SystemExit(f"[error] predict.py not found at {predict_py}; set RDMD_CONTRACT_DIR")

    token = env("RDMD_DEVICE_GRANT")
    adapter = env("RDMD_ADAPTER")
    model = env("RDMD_BASE_MODEL")
    missing = [name for name, value in (
        ("RDMD_DEVICE_GRANT", token), ("RDMD_ADAPTER", adapter), ("RDMD_BASE_MODEL", model),
    ) if not value]
    if missing:
        raise SystemExit(f"[error] missing required env: {', '.join(missing)}")

    config = {
        "cloud_api": env("RDMD_CLOUD_API", "http://127.0.0.1:8787"),
        "token": token,
        "adapter": adapter,
        "model": model,
        # baseModelId 优先取显式的 HF id（`RDMD_BASE_MODEL_ID`）；没有就用本地路径。
        # 用路径而不是编一个名字：出处的作用是让人能定位到那份权重，编的名字做不到。
        "base_model_id": env("RDMD_BASE_MODEL_ID") or model,
        "python": env("RDMD_PYTHON", "/root/autodl-tmp/rdmd-env/bin/python"),
        "device": env("RDMD_DEVICE", "cuda:0"),
        "max_new_tokens": int(env("RDMD_MAX_NEW_TOKENS", "160") or 160),
        "worker_id": env("RDMD_WORKER_ID") or f"gpu-{platform.node()}",
        "poll_seconds": float(env("RDMD_POLL_SECONDS", "10") or 10),
        "batch": max(1, min(4, int(env("RDMD_BATCH", "1") or 1))),
        "contract_version": "",
        "rule_version": "",
    }
    adapter_sha = adapter_sha256(adapter)
    local_contract = resolve_contract_version(deploy_dir)
    log(f"worker={config['worker_id']} api={config['cloud_api']} adapter_sha256={adapter_sha[:16]}…")
    log(f"contract(deploy)={local_contract} base_model={config['base_model_id']}")

    while True:
        try:
            claimed = api(config["cloud_api"], config["token"], "/api/rdmd/jobs/claim",
                          {"workerId": config["worker_id"], "limit": config["batch"]})
        except CloudError as error:
            log(f"[error] claim rejected: {error}")
            if args.once or error.status in (401, 403):
                return 2
            time.sleep(config["poll_seconds"])
            continue
        except Exception as error:  # noqa: BLE001 - 网络抖动不许让 worker 退出
            log(f"[error] claim failed: {type(error).__name__}: {error}")
            if args.once:
                return 2
            time.sleep(config["poll_seconds"])
            continue

        # 云侧下发的契约/规则版本，每个响应都可能变（云侧升级后立刻生效）。
        config["contract_version"] = str(claimed.get("contractVersion") or "")
        config["rule_version"] = str(claimed.get("ruleVersion") or "")
        if config["contract_version"] and config["contract_version"] != local_contract:
            # **绝不产出判定**：这等于用一个旧契约的判定去冒充新契约的出处。
            log(f"[FATAL] contract mismatch: cloud={config['contract_version']} "
                f"deploy={local_contract}. Refusing to return verdicts — redeploy deploy/ first.")
            return 3

        jobs = claimed.get("jobs") or []
        if jobs:
            log(f"claimed {len(jobs)} job(s)")
        for job in jobs:
            process_job(job=job, config=config, predict_py=predict_py, adapter_sha=adapter_sha)

        if args.once:
            log("--once: exiting")
            return 0
        if not jobs:
            time.sleep(config["poll_seconds"])


if __name__ == "__main__":
    sys.exit(main())
