# CPIR-Web 后续执行清单 v1

> 只关注创新新颖度与技术深度。本文是 `planned/unverified` 研究路线，不要求现在修改 Janus/uBuddy runtime、API、数据库 schema 或既有实验。

## 一、已经停止的工作

以下方向暂时不要继续投入：

1. 不再把 AOC-DP、PBES、DRAS 表述为新 planner；shared-oracle 下已与 robust belief-state model checker 等价。
2. 不再把 ABCA/VCC/PREE 表述为不可替代新协议；强成熟组合获得相同 verifier 后 trace-equivalent。
3. 不再通过增加 schema、digest、guard、checker、fixture 或协议缩写提高新颖性。
4. 不再优先写论文包装；先产生能改变当前负结论的技术证据。

当前研究定位：

> Web typed effect-admission formalization + replayable certificate interface + falsification benchmark

## 二、接下来只做三条工作线

### Workstream A：证明 certificate 是否有额外信息价值

研究问题：即使 policy/verdict 等价，结构化 Web obstruction certificate 是否比标准 POMDP/model-checker counterexample、MUS/MaxSAT core 和成熟 stack 日志提供更多可重放信息？

具体任务：

1. 冻结 certificate projection：obligation、world cell、probe closure、activation lineage、authority frontier、escrow binding、linearization witness、sink delta。
2. 实现三种 baseline certificate：generic counterexample trace、deletion-MUS/MaxSAT core、mature-stack audit log。
3. 定义 candidate-independent 信息指标：
   - 能否重放出同一 verdict；
   - 是否定位到最小 hard-obligation 集；
   - 是否包含恢复判断所需的 authority/activation/finality frontier；
   - certificate 字节数、oracle calls、验证时间；
   - 删除任一 witness atom 后是否失效。
4. 在 AL/PC/ER/AN 及双故障组合上比较。

通过条件：在相同 verdict/policy 下，CPIR certificate 至少在一个预注册指标上严格优于全部强 baseline，且优势不是因为 baseline 被禁止读取同一 raw oracle 字段。

停止条件：若 generic trace/MUS 加相同 projection 后信息等价，则 certificate 只保留为标准化接口，不再作为核心新颖性。

### Workstream B：缩小“声明模型—真实 Web”鸿沟

研究问题：当前 Web 特异性是否能在真实生命周期、authority 和 durable sink 故障中复现，而不只是 finite fixture？

按顺序实施：

1. `Browser lifecycle adapter`：Playwright 触发 BFCache restore、Service Worker controller change、多 tab、partition/storage change；只采集事件，不修改现有 runtime。
2. `Authority log adapter`：本地签名 event log，覆盖 ISSUE/REVOKE、frontier、key rotation、predecessor DAG。
3. `Durable escrow/sink adapter`：SQLite/WAL 独立研究 harness，覆盖 reserve/consume、kill/restart、response drop、receipt replay。
4. `Oracle JSONL recorder`：把真实事件规范化为 oracle manifest/trace；异常和无法验证字段保持 `UNKNOWN`。

通过条件：AL/PC/ER/AN 至少各一个真实可重放 trace；进程重启后 oracle verdict 与 ledger 不变量仍可复核；不得用 supplied `signatureVerified` 或 hidden `commitState` 代替真实证据。

### Workstream C：建立 falsification benchmark

研究问题：benchmark 能否公平揭示常见局部 Web stack 的漏洞，同时也允许 strongest mature stack 证明等价？

具体任务：

1. 冻结 AL/PC/ER/AN 单故障和关键双故障 split；world、fault、projector、预算、trust root 全部版本化。
2. baseline：local freshness stack、OAuth/DPoP+ACL+CAS+idempotency/outbox+receipt、同 verifier strongest stack、robust model checker、MUS/MaxSAT。
3. 指标：false-SAFE、UNKNOWN/abstain、effect cardinality violation、trace replay、certificate completeness、oracle calls、状态展开、时间/内存、probe cost。
4. 输出正结果和负结果；strongest stack 等价不得隐藏。

通过条件：benchmark 对弱基线能产生可解释 false-SAFE，对强基线能正确显示等价，并且不同 baseline 使用相同 oracle、预算和 fault schedule。

## 三、推荐执行顺序

| 顺序 | 交付物 | 预计结论用途 |
|---:|---|---|
| 1 | certificate projection + 三种 baseline certificate | 判断是否还有方法新颖性出口 |
| 2 | AL/PC/ER/AN 双故障 manifest | 防止只在单一 toy pair 上成立 |
| 3 | SQLite durable escrow/sink harness | 提升技术深度与故障真实性 |
| 4 | Browser lifecycle adapter | 证明问题真正依赖 Web |
| 5 | Authority signed event log | 消除 `signatureVerified` 布尔假设 |
| 6 | 完整 benchmark comparison | 最终决定主张等级 |

优先做第 1 项。若 certificate 也完全等价，立即接受最终定位，不再寻找 solver/protocol 名称上的创新；后续只做高质量 formalization、系统化 benchmark 和真实故障证据。

## 五、证书信息量闸门的当前结果

已实现 `ubuddy-cpir-web-certificate-information-v1.mjs`：CPIR、generic model-checker、mature-stack 三者在接收相同完整 typed projection 时均可完整 replay；native generic trace 和 native mature audit 也可验证 verdict，但缺少部分 activation/authority/escrow/finality 字段。CPIR 的“信息增益”目前只能称表示层增益，不能称内在算法新颖性。删除证书 cell、篡改 verdict、修改 commitment hash 均会被检测。测试 `18/18` 通过。

## 四、每一步的完成定义

每个 work item 必须同时产出：

- 可复跑命令和固定输入；
- 正例、负例、timeout/bound/缺证据案例；
- candidate-independent oracle 输出；
- 与至少一个公平强 baseline 的同输入比较；
- 明确的负结论和停止条件；
- `research-prototype/unverified` 或 `planned/unverified` 状态标签。

不得以“测试数量增加”作为完成；必须改变以下至少一项：新系统语义、真实 fault coverage、certificate information advantage、复杂度/成本证据或信任假设。

## 六、双故障 falsification coverage

已新增 `ubuddy-cpir-web-oracle-double-faults-v1.mjs`，覆盖 AL+PC、AL+AN、PC+ER、ER+AN 四类组合故障。oracle 不在第一个失败 guard 处截断，而是保留全部 violated guard witness；测试 `17/17`。这提升错误诊断和 benchmark 覆盖，但不改变“算法新颖性仍未证明”的结论。

## 七、durable sink/escrow harness 结果

新增独立 SQLite/WAL 研究 harness：`ubuddy-cpir-web-durable-sink-harness-v1.mjs`，并用真实子进程模拟“commit 后 response 丢失”。已验证 WAL reopen、双连接 stale revision、事务内失败 rollback、cross-process crash recovery、single-use replay、finality monotonicity 和 ledger audit；测试 `29/29`。它只证明本地研究 harness 的 durable 行为，不证明外部 Web sink exactly-once、OAuth authenticity 或 runtime safety。

## 八、signed authority log 结果

新增 `ubuddy-cpir-web-authority-signed-log-v1.mjs`，用 Ed25519、revision hash-chain、frontier completeness 和 equivocation 检查替代裸 `signatureVerified` 布尔值；oracle 支持 `SIGNED_CAPABILITY_ACTIVE` guard。测试 `12/12`，覆盖签名篡改、缺 key、frontier gap、hash-chain break、同 revision equivocation、revoke 推导和 oracle 集成。该工件是本地 authority 研究原型，不是 OAuth introspection 或真实 consent 证明。
