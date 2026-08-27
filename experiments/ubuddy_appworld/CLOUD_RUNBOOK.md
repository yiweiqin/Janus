# 云端直接运行手册

## 推荐实例

- Ubuntu 22.04/24.04
- 8 vCPU 起步，16 vCPU 推荐
- 16GB RAM 起步，32GB RAM 推荐
- 100GB SSD 起步，200GB 推荐
- Python 3.11、Node 20+、Git LFS

AppWorld 主实验不需要 WebArena 的大型 Docker 网站，32GB 云主机可以稳定完成主实验。WebArena 只在 external 阶段单独启用。

## 上传和安装

```bash
git clone <Janus repository>
cd Janus
bash experiments/ubuddy_appworld/cloud_bootstrap_ubuntu.sh
bash experiments/ubuddy_appworld/cloud_setup.sh
source .ubuddy_appworld_env
```

配置模型环境变量（只在 shell 或云平台密钥管理器中配置）：

```bash
export CRS_OAI_KEY='...'
export OPENAI_BASE_URL='...'
export UBUDDY_APPWORLD_ENABLE_REAL='1'
export UBUDDY_APPWORLD_MODEL='gpt-5.4-mini'
```

## 运行顺序

```bash
npm run experiment:ubuddy:appworld:doctor
npm run experiment:ubuddy:appworld:manifest
bash experiments/ubuddy_appworld/run_cloud_canary.sh
```

当前 canary 默认只验证协议；真实 AppWorld agent 需要把模型生成的 AppWorld Python action JSON 通过 `--action-file` 传给 bridge。接入 Janus 的真实模型调度器后，再运行：

```bash
npm run experiment:ubuddy:appworld:main -- --real --action-file <generated-actions.json>
npm run experiment:ubuddy:appworld:attribution
npm run experiment:ubuddy:appworld:evolution
npm run experiment:ubuddy:appworld:external
npm run experiment:ubuddy:appworld:verify -- --run-dir <run-dir>
npm run experiment:ubuddy:appworld:report -- --run-dir <run-dir>
```

## 不同证据不能混淆

- `protocolOnly=true` 不是任务成功率；
- `appworld-official` evaluator 才是主任务分数；
- Who&When 只评估归因，不代替 AppWorld 任务成功率；
- WebArena-Verified 只作为真实 Web 外部验证；
- 只有第二轮迁移任务提升，才报告“联合进化有效”。
