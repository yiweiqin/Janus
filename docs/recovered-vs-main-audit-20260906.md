# 主仓库与恢复副本差异审计（2026-09-06）

## 结论

- 主仓库较新的核心运行时：Cloud 协作、TDB、决策充分性、披露边界、Probe 和证据门控。
- 恢复副本较新的研究/实验层：FormalChain、QCP-IHG，以及更大的 OrgBench runner。
- 两者不是可直接覆盖的同一版本；需要按模块合并。

## `experiments/ubuddy_orgbench/orgbench_experiment.mjs`

- 主仓库：1787921192.7745376 UTC, 76347 bytes, SHA256 `afcf40e39741dabe91400acd46732ce3a78df576d2fa21d8e191701ba8e81582`
- 恢复副本：1788696245.3784115 UTC, 98186 bytes, SHA256 `61f8b251ba3e4763ba6b3a8c6fa9b2f81fb9ff35799eb966e0971b2d080954ed`
- 文件相同：False

## `experiments/ubuddy_orgbench/core/modelPolicy.mjs`

- 主仓库：1788693258.3857744 UTC, 7238 bytes, SHA256 `654937cb123c84d83d0d205bdc4cec8b8c176cc18f4886a683e996437d48fc7c`
- 恢复副本：1788694716.656751 UTC, 10419 bytes, SHA256 `71628d72bd994add04802155f6bc830bec36f33591c93ca216e7e4bf61ae848f`
- 文件相同：False

## `experiments/ubuddy_orgbench/core/stateGraph.mjs`

- 主仓库：1787808837.5181372 UTC, 2984 bytes, SHA256 `89d76e1f82f37c204d943db36cb909da6307858641dc56503ea70a8572e640f2`
- 恢复副本：1787988701.0 UTC, 5039 bytes, SHA256 `fdb9364dc9df2f69de3f1081ef26b061c4b2e1af0ef2c9bb8f8127091ad54ea1`
- 文件相同：False

## `src/shared/contracts/uBuddyFormalChain.js`

- 仅恢复副本存在：12169 bytes

## `src/shared/contracts/uBuddyFormalChain.test.js`

- 仅恢复副本存在：1594 bytes

## `src/shared/contracts/uBuddyQcpIhg.js`

- 仅恢复副本存在：22753 bytes

## `src/shared/contracts/uBuddyQcpIhg.test.js`

- 仅恢复副本存在：5609 bytes

## `src/shared/contracts/uBuddyDependencyBundle.js`

- 仅恢复副本存在：4214 bytes

## 暂不自动覆盖的文件

- `experiments/ubuddy_orgbench/orgbench_experiment.mjs`：恢复副本版本更晚且更大，但可能依赖恢复副本特有的 runner/review API。
- `core/modelPolicy.mjs`：两份都在 2026-09-06 修改，需逐函数合并。
- `uBuddyFormalChain.js` 与 `uBuddyQcpIhg.js`：主仓库缺失，先作为候选新模块，不能假设已接入主服务端。