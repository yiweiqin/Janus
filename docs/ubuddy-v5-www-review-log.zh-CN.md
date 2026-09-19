# uBuddy/Janus v5 WWW 独立审稿日志

## 第 1 轮：从通用 CP-RIR 收敛到 CPIR-Web（2026-09-01）

### 研究动作

- 读取 v2/v3/v4 痛点、创新、技术深化与 review 材料；旧版 fixture、digest、checker 作为研究证据，不作为系统能力。
- 将主问题改写为跨浏览器、跨网站、跨 SaaS API、OAuth/session、webhook 和不可逆外部 sink 的 repair-before-effect。
- 提出 10 个候选，合并为三条主贡献：Web typed hidden-world model、PBES probe-before-effect contract-preserving synthesis、paired-world Web benchmark。
- 将 provenance、gateway、Saga、ESCROW、FSM、root-auth、checker 降为支撑或 falsification，不再作为主创新。

### 五视角复核

**问题定义**：Web 特异性只有在身份、租户、OAuth scope、版本、异步 webhook 和外部 effect 同时进入状态/合同后才成立；单纯把旧 CP-RIR 换成“Web”不足。必须区分 model-relative repair、current-instance root cause 和 population value。

**隐私/信息论**：跨站 alias、OAuth subject、webhook timing 和 effect receipt 可能产生 linkability；public projector 仍不是 noninterference/privacy。WWW 论文应把 disclosure budget 当风险维度，而非无证据宣称隐私贡献。

**因果/诊断**：probe 必须有明确 support、可执行 owner/scope 和低副作用边界；观察性日志不能推出根因。缺 positivity、receipt 或 effect support 时必须 abstain。

**分布式/Web 安全**：OAuth scope、租户 owner、API version fence、webhook drop/dup/reorder 和 sink linearization 是 Web 真实约束；Saga/gateway 不能自动产生 probe selection 或 contract preservation。

**形式化/复杂度**：PBES 可先给有限 belief-tree 定义、bounded soundness/abstention necessity 目标；复杂度暂只声称显式搜索指数级，并研究固定 horizon/treewidth 下的 FPT，不套用未经证明的 hardness 或近似结论。

### 相邻工作排雷记录

检索家族与关键词：Web/Browser Agents；workflow repair/replanning；causal RCA/intervention；safe planning/MDP；Saga/2PC/distributed transaction；provenance/attestation；OAuth/capability security；human-in-the-loop agents。具体论文、年份、链接和 DOI 尚待人工核验，本轮不写未经确认的引用。

Crossref 可核验记录（检索日 2026-09-01）：`Mind2Web: Towards a Generalist Agent for the Web`（2023，DOI `10.52202/075280-1220`）；`Mind2Web 2: Evaluating Agentic Search with Agent-as-a-Judge`（2025，DOI `10.52202/085713-5778`）；`SAGA Distributed Transactions Verification Using Maude`（2022，DOI `10.1109/isnib57382.2022.10076050`）。这些只作为 Web-agent benchmark 与事务验证的相邻定位，不据此声称它们覆盖 CPIR-Web 的 interventional probe、contract conservation 或 abstention necessity；其他家族条目标记待人工核验。

### WWW 独立评分

| 维度 | 评分 | 主要理由 |
|---|---:|---|
| Web relevance | 7.4 | 跨站身份、SaaS API、webhook、外部 effect 使痛点具体，但缺真实 Web replay |
| Novelty | 6.2–6.6 | 问题组合有潜力，尚未证明超出 safe planning + workflow repair 的不可替代算法 |
| Technical depth | 6.1–6.5 | typed model、PBES、support/abstain 和理论目标清晰，仍 planned |
| Experimental credibility | 4.8–5.4 | 目前主要是 fixture/prototype，缺 locked benchmark 与真实故障注入 |
| Overall | Borderline / Weak Reject | 需要 Web-specific artifact 与可复现 baseline 才能上升 |

### 采纳与拒绝

采纳：将 Web 的身份/租户/版本/异步 receipt/不可逆 effect 写入问题定义；将 probe-before-effect 和 abstention 作为核心机制候选；将 paired-world benchmark 作为必须的实验贡献。

拒绝：把旧版 checker/digest/schema 数量当作新颖性；把 planned replay、root hash、ESCROW、fixed-shape projector 写成真实 runtime safety、privacy、exactly-once、all-or-none 或 Strong Accept。

### 三个最大 blocker

1. 尚无独立 Web execution/replay evidence，无法证明问题在真实浏览器/SaaS workflow 中普遍存在。
2. PBES 与 safe planning、workflow repair、active diagnosis 的不可替代性尚未形成正式定理或清晰反例。
3. OAuth/tenant/sink receipt 的 trust boundary、effect linearization 和 benchmark 标注协议尚未落地。

### 下一轮最小修改

1. 给出 Web typed transition schema 和两个具体 paired-world 场景；
2. 给出 PBES 的 bounded soundness/abstention necessity 形式化目标与失败边界；
3. 设计可复现 simulator/replay benchmark 及 baseline/ablation 矩阵，所有未实现部分标 `planned/unverified`。

## 第 2 轮：PBES paired-world 原型（2026-09-01）

### 实跑证据

- depth-1 PBES 正例输出 `UNKNOWN_INPUT_NOT_PROVEN / FINITE_PBES_DECLARED_MODEL_VALID_RUNTIME_UNVERIFIED`。
- OAuth subject mismatch vs webhook delay：无 probe 时无 universally-safe repair；低风险 identity/receipt probe 后形成两个可修复分支。
- API version drift vs effect committed/receipt lost：低风险 probe 返回同一观察，模型内必须 abstain。
- negative **6/6**，syntax 与 `git diff --check -- docs` 通过。

### 相邻工作排雷

Web-agent benchmark 方向提供任务和环境；active diagnosis/safe planning 提供 belief/probe 相关思想；workflow repair 提供计划修改；Saga/gateway 提供 effect 提交模式；provenance 提供事件来源。当前 PBES 的潜在新增点是把 Web identity/version/webhook/effect contract、低风险 probe partition 和 fail-closed abstention放入同一输出语义。由于 Semantic Scholar 查询部分触发 429，本轮没有补写不能独立核验的具体引用。

本轮用 Crossref 元数据补充可核验的相邻定位（检索日 2026-09-01）：`Safe POMDP Online Planning via Shielding`（ICRA 2024，DOI `10.1109/icra57147.2024.10610195`）代表受约束部分可观测安全规划；`Policy search for active fault diagnosis with partially observable state`（2022，DOI `10.1002/acs.3456`）代表主动诊断；`EconWebArena: Benchmarking Autonomous Agents on Economic Tasks in Realistic Web Environments`（2026，DOI `10.18653/v1/2026.gem-main.67`）和 `WebMall - A Multi-Shop Benchmark for Evaluating Web Agents`（2026，DOI `10.1145/3805712.3808592`）代表真实 Web 任务 benchmark。它们说明 PBES 必须在 comparison table 中明确新增的 contract-preserving effect legality、probe budget 和 fail-closed abstention；本记录不声称这些工作缺少其论文未核验的全部细节。

### 独立 WWW 审稿

采纳：用两个 Web paired worlds 展示“同一公开页面/timeout，不同安全 repair”；原型不读取预期结果；将 human confirmation 视为可能的 probe 而非万能安全机制。

打回：两个手工 case 仍可能被评为 safe planning 的小型实例；尚无多步算法、正式 theorem、真实 Web execution 或规模化 benchmark。不得把 model-relative branch safety 写成 runtime safety、current root cause 或 population efficacy。

评分：Web relevance **7.7/10**；Novelty **6.4–6.8/10**；Technical depth **6.5–6.9/10**；Experimental credibility **5.0–5.6/10**；总体 **Borderline / Weak Reject**。

三个最大 blocker：

1. 尚未证明 PBES 相比 constrained POMDP/active diagnosis + transaction gateway 具有不可拆解的新性质；
2. 只有 depth-1 手工 world table，没有多步 belief-tree、真实 browser/API/webhook replay；
3. authoritative OAuth/sink receipt 和不可逆 effect 标注仍不存在。

下一轮最小修改：实现多步 PBES 或给出可审计伪算法；完成 one-step soundness/abstention necessity 证明草案；定义不少于 20 个 paired-world benchmark 模板及 baseline/ablation protocol。

## 第 3 轮：多步 PBES 与 paired-world benchmark 扩展（2026-09-01）

### 实施记录

- 新增 v1 typed schema、三案例输入、递归 checker 与 12 个负例 runner；工件状态均为 `prototype/unverified`。
- 多步节点显式携带 belief、剩余风险预算、深度、观察集和 contract ledger；支持 observation partition、branch-level repair/abstain 与 belief-state memoization。
- 示例覆盖：identity→receipt 二步分支；risk budget 不足导致 partial repair/abstain；所有声明 probe 均不区分支付已提交/未提交的必要 abstention。当前 branch safety 是对 fixture `safeByWorld` 的 universal lookup，不是 transition-derived runtime safety。
- 实跑结果：`MULTI_STEP_CONTINGENT_PLAN`（3/3 declared worlds，worst-path risk 0.3，depth 2）；`PARTIAL_REPAIR_WITH_ABSTENTION`（1/3）；`ABSTAIN_NECESSARY_UNDER_DECLARED_MODEL`（0/2）；整体仍输出 `UNKNOWN_INPUT_NOT_PROVEN / FINITE_MULTISTEP_PBES_DECLARED_MODEL_VALID_RUNTIME_UNVERIFIED`。
- 原型按 repaired-world cardinality 选择 partial plan，这对 world 枚举不具 representation invariance；本轮不把该排序视为论文算法贡献。

### 24 个 paired-world Web benchmark 模板（planned/unverified）

| # | Web workflow / public cut | Paired hidden causes | 安全 repair 分歧 |
|---:|---|---|---|
| 1 | 购物车→结账 2xx 但订单未知 | API version drift / order committed receipt lost | 升级后原 key 提交 / 只查 receipt |
| 2 | 支付按钮超时 | pre-commit drop / commit status lag | 重提交 / 等待对账 |
| 3 | CRM 联系人创建成功页 | wrong OAuth subject / webhook delay | 重新授权写入 / 等 webhook |
| 4 | 工单关闭页面 | stale ETag / close already committed | refresh-and-close / reconcile |
| 5 | 日历邀请发送未知 | timezone validation fail / email queued | 修正参数 / 查投递状态 |
| 6 | 云盘共享链接生成未知 | tenant mismatch / link already created | 重建正确租户 / 查 link receipt |
| 7 | HR 权限授予超时 | scope expired / grant committed | refresh scope / verify grant |
| 8 | 订阅升级页面成功 | plan version drift / charge committed | reprice-and-submit / reconcile charge |
| 9 | 发票生成未知 | API schema drift / invoice persisted | migrate request / fetch invoice |
| 10 | 物流标签打印未知 | carrier API timeout / label committed | retry with same key / retrieve label |
| 11 | 社交媒体发帖未知 | OAuth account alias mismatch / post queued | rebind account / inspect post id |
| 12 | 知识库发布未知 | stale revision / publish committed | merge revision / read publish receipt |
| 13 | 数据导出完成页 | permission denial masked / export running | reauthorize / poll job |
| 14 | 会议录制启动未知 | browser session expired / recording started | re-login / fetch recording status |
| 15 | 电商退款超时 | refund rejected / refund committed | fix payment reference / reconcile refund |
| 16 | 邮件退订页面成功 | wrong list tenant / unsubscribe committed | rebind list / verify suppression |
| 17 | 广告预算变更未知 | version fence fail / budget applied | refresh fence / read campaign receipt |
| 18 | 数据库 SaaS migration 页面 | webhook dropped / migration committed | replay webhook / inspect migration |
| 19 | No-code workflow publish | dependency version drift / workflow published | pin dependency / verify revision |
| 20 | 密码重置成功页 | identity mismatch / token consumed | restart correct identity / verify reset |
| 21 | API key rotation unknown | permission denied / key rotated | reauthorize / retrieve key metadata |
| 22 | 工资单提交未知 | duplicate-prevention lock / payroll committed | repair lock / reconcile batch |
| 23 | 客服工单合并未知 | stale ticket revision / merge committed | rebase merge / inspect canonical ticket |
| 24 | 文件签名请求未知 | signer scope mismatch / envelope sent | request correct scope / query envelope receipt |

每个模板需锁定：相同 `public cut`、至少两个 hidden world、至少一个可执行 read-only probe、至少一个 world-dependent safe repair、owner/scope/version/receipt 字段、不可逆 effect 标注和人工 gold label。模板尚未在真实网站运行，不能当作实验结果。

### Baseline / ablation protocol

比较 `retry`、`replan`、`reflection`、`provenance-only`、`Saga/gateway-only`、`oracle-world`、`PBES`；消融 `−multi-step`、`−risk budget`、`−contract gate`、`−version fence`、`−receipt probe`、`−abstain`。主指标为 hard-contract violation、irreversible-effect error、abstention precision/coverage、worst-path risk/cost、utility lower bound 和 observation alignment；任务成功率只作为 soft utility，不作为 safety/causal efficacy 证据。

### 第 3 轮独立 WWW 评分

| 维度 | 评分 | 审稿理由 |
|---|---:|---|
| Web relevance | 8.0 | typed identity/version/webhook/sink 与 24 个真实 Web workflow 模板使问题更具体 |
| Novelty | 6.8–7.1 | 多步 probe ordering + branch abstention 比 depth-1 更难被单次 replan 替代，但仍需与 constrained POMDP/active diagnosis 正式对比 |
| Technical depth | 7.0–7.3 | 有递归语义、memoization、复杂度和两项证明草案；尚未机器证明 |
| Experimental credibility | 5.3–5.9 | benchmark 协议完整度提升，但 24 模板仍 planned，缺真实 replay/receipt 验签 |
| Overall | Borderline（接近 Weak Accept） | 理论和实验设计变强，但证据尚不足以越过 WWW 接收线 |

### 仍未解决的三个 blocker

1. 必须给出 PBES 相对 constrained POMDP / active diagnosis + gateway 的不可替代反例或定理，而非只描述组合差异。
2. 必须把至少一部分 paired worlds 运行在可复现 browser/API/webhook simulator 或公开 benchmark adapter 中，并锁定 effect/receipt 标注。
3. 必须明确 OAuth/tenant/sink receipt 的信任边界；当前 checker 只能验证 supplied artifact consistency，不能证明真实性、隔离性、exactly-once 或 rollback。

### 下一轮最小任务

1. 构造一个“任何单步/无 contract 的 POMDP policy 都 fail-open，而 PBES 多步策略安全”的形式化反例，并写出可审计证明。
2. 为 24 模板选出 6 个优先场景，定义 simulator trace schema、fault injection 和 gold effect ledger。
3. 补充相邻工作逐项引用和 comparison table，并把 partial-plan 的 cardinality heuristic 替换为锁定 measure 下的 robust objective 或 Pareto set；若发现已有方法已具备同等 probe/abstain 语义，必须合并或重做主贡献。

## 第 4 轮：Contract-conflict separation 与六场景 simulator 规格（2026-09-01）

### 本轮研究问题

有限 PBES belief-tree 可被编码为 constrained POMDP；本轮不再声称一般表达能力更强，而是定义 Web 特有的 contract-conflict separation：相同 public cut 下，哪些 hidden worlds 对 hard obligation 产生冲突，哪些低风险 probe 能分离这些冲突，预算内无法分离时如何生成带 witness 的 abstention certificate。

### 候选与相邻工作排雷

提出 C11–C18 八个候选：contract-conflict hypergraph、contract-separating probe tree、irreversibility frontier、cross-plane alias relation、receipt–version conflict edge、budgeted certificate lower bound、paired-world mutation generator、effect-ledger risk metrics。结论：只保留 contract-conflict model、conflict-separating PBES、effect-ledger benchmark 三条主贡献；hypergraph、frontier、alias、receipt edge 和 metrics 是定义/支撑，不能平铺为八条创新。

排雷结论：constrained POMDP 可表达有限 policy；active diagnosis 可表达 test policy；Saga/gateway 可限制提交；provenance 可记录来源；OAuth/ACL 可验证单次授权；human confirmation 可提供额外 observation。因而 CPIR-Web 的新颖性必须落在 Web obligation/effect schema、冲突边 certificate 和以错误副作用为核心的 benchmark，而不是 belief-tree 术语。

### 新增研究工件

- `ubuddy-cpir-web-six-simulator-spec-v0.zh-CN.md`：六个优先场景、统一 trace envelope、gold effect ledger、fault injection、270 条首版规模目标和 baseline/ablation 协议。
- v5 技术文档新增 contract-conflict hypergraph、abstention certificate、与 constrained POMDP 的诚实边界、Weighted Set Cover→BCS-TREE 的 NP-hard proof draft，以及 partial repair 的 unresolved-edge Pareto objective。

### 形式化和实验边界

`conflict-edge` 的 separation 与 certificate closure 仍是 planned；NP-hard reduction 目前是纸面 proof draft，尚未同行/机器核验，不能扩展成 NP-complete、近似比或一般 runtime hardness。simulator 规格未运行前不能称实验结果；`safeByWorld` fixture 也不能替代 transition-derived legality、OAuth authenticity 或 sink receipt authenticity。

### 第 4 轮独立 WWW 评分

| 维度 | 评分 | 审稿理由 |
|---|---:|---|
| Web relevance | 8.2 | identity/tenant/version/webhook/receipt/effect ledger 被统一为冲突标注对象，六场景可执行性更强 |
| Novelty | 6.9–7.2 | 诚实承认 POMDP 可表达 policy 后，新意转为 Web contract-conflict certificate 与 effect-centric benchmark；仍需证明不是 constraint annotation 的重命名 |
| Technical depth | 7.4–7.8 | hypergraph、certificate closure、完整的 Set Cover reduction 草案和 unresolved-edge Pareto objective 形成技术链；尚未同行/机器证明 |
| Experimental credibility | 5.8–6.3 | trace/gold ledger/fault split 明确，首版仍未执行真实或 simulator replay |
| Overall | Borderline / Weak Reject | 方向比上一轮更聚焦，但还缺不可替代实证和实际 replay |

### 采纳与拒绝的审稿意见

采纳：将“PBES 严格超越 POMDP”降为不可主张；将 certificate、effect ledger 和冲突边作为可验证接口；把真实副作用错误而非单纯 task success 作为 benchmark 主指标。

拒绝：继续堆叠 schema/checker 作为 novelty；把 Set Cover 直觉写成已证明 hardness；把 simulator/oracle 结果写成 runtime safety 或 current-instance root cause。

### 三个最大 blocker

1. 必须完成一个不依赖术语的 conflict-edge separation 定理/反例，并证明普通 reward-constrained POMDP 输出无法提供同等可审计 certificate（或承认其可提供并降级贡献）。
2. 必须实际运行 S1–S6 中至少一部分 deterministic simulator traces，报告 gold effect ledger 与 baseline 错误副作用。
3. 必须将 `safeByWorld` 替换为从 transition/contract 推导的 legality，或明确把现阶段贡献限定为 benchmark/formalization。

### Simulator 首次运行记录

独立研究工件 `ubuddy-cpir-web-simulator-v0.mjs` 已运行 S1–S6，每个场景 3 worlds×5 seeds，共 **90 条 deterministic traces**；输出为 `ubuddy-cpir-web-simulator-v0.output.json`。在当前 declared simulator：PBES 的 contract violation 为 S1 0/15、S2 0/15、S3 0/15、S4 0/15、S5 0/15、S6 0/15；S2 因 settlement scope 缺失 abstain 5/15，S4 因 intervening update abstain 5/15。retry/replan/provenance-only 在 S1、S2、S4 各有 5/15 violation，在 S3 有 15/15，在 S5/S6 各有 10/15。gateway-only 仅在 S2 通过缺 scope 拒绝，仍无法处理其他 conflict。

这些数字仅证明 simulator 能生成 paired worlds、fault timing 和 gold ledger；尚未经过独立实现复核，也没有真实浏览器、OAuth provider、支付或 SaaS sink。不得把它们写成 runtime safety、population efficacy 或因果修复效果。

独立 checker `ubuddy-cpir-web-simulator-checker-v0.mjs` 进一步验证 18 个 world×seed group、90/90 traces、5 个 policy 输出和每条 gold ledger；negative runner **5/5** 通过，输出 `SIMULATOR_TRACE_LEDGER_CONSISTENCY_VALID_RUNTIME_UNVERIFIED`。

### 相邻家族 comparison table（保守、待论文级全文核验）

| 家族 | 已有能力 | CPIR-Web 必须额外证明的部分 | 当前证据 |
|---|---|---|---|
| constrained/safe POMDP | belief policy、reward/constraint、shielding | obligation-level conflict certificate、Web effect ledger interface 的额外价值 | 仅定义和 synthetic simulator |
| active diagnosis | 选择 test/probe 区分 faults | probe 本身的 scope/effect legality，以及 diagnosis 后 repair contract | 纸面模型 |
| workflow repair/replan | 修改流程或计划 | 不弱化 tenant/version/idempotence/effect obligations | fixture + simulator |
| Saga/transaction gateway | compensation、提交/授权边界 | 部分可观测时先 probe/repair/abstain 的 policy | synthetic gateway-only baseline |
| provenance | event/source lineage | 来源证据到 action legality 的推导 | 尚未实现 transition-derived legality |
| human-in-the-loop | 获取确认、授权或新 observation | 确认无区分力时的 abstention necessity | planned ablation |
| Web-agent benchmarks | browser task 与 success metric | paired hidden worlds、不可逆 effect error 与 gold receipt ledger | 6-scenario simulator/prototype |

已由 Crossref 元数据核验并用于定位的条目包括 `Safe POMDP Online Planning via Shielding`（ICRA 2024，DOI `10.1109/icra57147.2024.10610195`）、`Policy search for active fault diagnosis with partially observable state`（2022，DOI `10.1002/acs.3456`）、`SAGA Distributed Transactions Verification Using Maude`（DOI `10.1109/isnib57382.2022.10076050`）、`EconWebArena`（2026，DOI `10.18653/v1/2026.gem-main.67`）与 `WebMall`（2026，DOI `10.1145/3805712.3808592`）。这里只核验元数据和研究家族定位，不据此断言其全文缺少某项机制。

### Simulator 后的修订评分

| 维度 | 评分 | 依据 |
|---|---:|---|
| Web relevance | 8.3 | 六个跨站/SaaS effect 场景、identity/version/receipt faults 与 ledger 已形成统一实验对象 |
| Novelty | 7.0–7.3 | contract-conflict separation 和 abstention certificate 比泛化 PBES 更聚焦，但 constrained POMDP 可编码仍是主要重叠风险 |
| Technical depth | 7.5–7.9 | 有多步算法、conflict object、NP-hard proof draft、Pareto objective、simulator/checker；transition-derived legality 仍缺失 |
| Experimental credibility | 6.1–6.6 | 90 条 deterministic simulator traces 和 5/5 mutation checks；policy/baseline 均为同一作者手工定义，公平性与真实度有限 |
| Overall | Borderline | 已摆脱纯概念稿，但不足以 Weak Accept；需要独立 baseline 和真实/公开环境 replay |

最严重的 fairness 风险：`retry`、`replan`、`provenanceOnly` 当前在 simulator 中共享同一个 public-cut fixed action，属于弱基线；PBES policy 又按场景手工编码 probe mapping。90 条结果因此只能证明 benchmark plumbing，不证明算法优势。下轮必须让 baseline 使用独立 planner/LLM 或公开实现，并将 policy synthesis 与 simulator world table 分离。

### 下一轮最小任务

1. 对 BCS-TREE reduction 与 certificate soundness 做独立形式化复核，补充必要/充分条件和反例。
2. 在不改 Janus runtime 的前提下实现独立 simulator runner（研究工件目录内），先跑 S1/S2/S3 各 5 seeds。
3. 生成逐项 comparison table，明确每个相邻工作是否已有 conflict certificate、effect ledger 和 fail-closed abstention。

## 第 5 轮补充：按用户要求收窄到创新与技术（2026-09-01）

本轮只评审创新点的新颖度和技术深度；论文完整度、统计包装和当前 runtime 改造不作为主阻塞。

### 三个创新 Agent 的独立结论

- Web 场景 Agent：authority continuity、receipt freshness/finality、model-validity envelope、intent-lineage fencing 最有 Web 特异性；observation coherence 和绑定式确认容易退化为 provenance/HITL。
- 方法 Agent：CES-PBES、irreversibility-frontier/effect-ledger reconciliation、scope–identity–version triage、budgeted certificate lower bound 可形成方法对象，但 policy tree 与 constrained POMDP 等价，不能作为严格新 planner。
- 理论 Agent：旧 `E_conf=Unsafe(a)∪Safe(a)` 恒等于全世界集，必须改为 inclusion-minimal 高阶 conflict subset，并区分 `CONFLICT`、`EPISTEMIC_BLOCKAGE`、`INFEASIBLE`、`UNKNOWN`；BCS-TREE 归约只保留为有限模型 proof draft。

### 三个技术 Agent 的独立结论

- 形式化：建立 `typed transition → 3-valued monitor → obligation conflict/blockage → AND-OR policy → closure certificate` 闭环；复杂度写为 `O((Pq)^H·WR)`，memoization 按 augmented state 计。
- Web 协议：优先深化 CACE-IL（effect admission）和 RFRE（post-linearization reconciliation）；字段需绑定 issuer、epoch、tenant revision、version fence、intent lineage、sink generation、commit index、freshness/finality。
- 方法路线：将评测对象分成 policy 与 certificate 两层；CPIR 只接 public projection + probe API，不应接收 hidden world；certificate 必须包含 witness 和完整 closure。

### 两个独立 Reviewer 的方法/技术评分

| Reviewer | 新颖性 | 技术深度 | Web 适配度 | 实验可信度 | 倾向 |
|---|---:|---:|---:|---:|---|
| WWW 新颖性 Reviewer | 5.8 | 6.5 | 7.7 | 4.3 | Weak Reject / Borderline |
| 技术严谨性 Reviewer | 5.7 | 4.2 | 7.2 | 4.6 | Weak Reject / Borderline |

共同一票否决：`PBES` 与 safe-POMDP 的算法差异尚未成立；conflict/certificate 当前不能证明高阶冲突和 abstention；hard safety 仍主要由 fixture 注入。综合 Agent 不宣布 WWW-ready。

### 综合裁决：保留、合并、淘汰

保留三条方法主线：

1. CACE-IL：effect admission 的跨平面 authority/intent continuity；
2. RFRE：receipt freshness/finality 与 post-linearization reconciliation；
3. proof-carrying Web effect benchmark：conflict/blockage witness、gold ledger 和 certificate interface。

降级：PBES 为 policy interface；conflict hypergraph 为定义工具；Saga/gateway/provenance/RCA/FSM/checker 为支撑。淘汰“PBES 严格超越 POMDP”、exactly-once、rollback、privacy 等无证据主张。

### 当前方法评分

| 维度 | 评分 | 解释 |
|---|---:|---|
| 新颖性 | 5.8–6.4 | planner 新意被否定；CACE-IL/RFRE 若形成跨平面可检查语义仍有潜力 |
| 技术深度 | 6.8–7.4 | 两阶段 effect protocol、三值 monitor、conflict closure 和最小定理包形成路线；仍多为 planned |
| Web 适配度 | 8.0–8.4 | OAuth/tenant/session/version/webhook/receipt/不可逆 sink 是问题必要条件 |
| 实验可信度 | 不作为本轮决策项 | synthetic 工件仅作未来验证材料 |
| 当前倾向 | Borderline / Weak Reject | 方法方向可继续，但未达到不可替代 |

### 可直接照做的 P0–P5 顺序

P0 冻结 CACE-IL/RFRE transition predicates 和 `{SAFE,VIOLATED,UNKNOWN}`；

P1 用 typed transition 自动推导 legality，移除 `safeByWorld` 主链；

P2 实现 inclusion-minimal 高阶 conflict/blockage registry；

P3 实现完整 probe closure、terminal cell、witness obligation 的 AND-OR certificate；

P4 在 unresolved obligations/risk/cost 上计算 Pareto frontier，删除 world-count heuristic；

P5 最后再接真实 Web adapter，之前不修改 Janus runtime。

详细执行门槛见 `ubuddy-v5-www-method-roadmap.zh-CN.md`。如果 P2–P3 完成后强 POMDP 加同一 verifier 仍完全等价，则停止新 planner 路线，保留 Web protocol/formalization/benchmark。

## 第 6 轮：执行目标文件中的 P0/P1 方法闭环（2026-09-01）

### 本轮范围

按用户要求只推进创新点的新颖度和技术深度，不改论文、不改 Janus/uBuddy runtime、不改 API/schema/既有实验实现。目标从附件 `goal-objective.md` 读取并作为本轮执行依据。

### 执行动作与工件

- 冻结 CACE-IL/RFRE 的 CACE 与 RFRE 状态转移；`FINAL_VERIFIED` 和 `COMMITTED` 不允许回退到未知/无提交状态。
- 实现六项 transition-derived obligations：authority、tenant、version、idempotence、effect cardinality、receipt policy。
- 统一三值判定：任意 `VIOLATED` 优先；无 violation 但有证据缺失则 `UNKNOWN`；仅全部安全才 `SAFE`。
- 加入 26 个 action、证据、状态、终止性和 admission-token 断言，结果全部通过。
- 运行旧独立 runner 回归：72 rows、4 policies，checker 返回 `SEPARATED_CATALOG_POLICY_EVALUATOR_CONSISTENT_RUNTIME_UNVERIFIED`。

### 这轮没有改变的内容

- 旧主链仍使用 `ubuddy-cpir-web-contract-evaluator-v1.mjs`；新 evaluator 尚未接管 runner，因此 P1 仍是“独立原型”，不是迁移完成。
- 没有真实 browser/API/OAuth/webhook/sink adapter；没有 receipt authenticity 或外部 world coverage。
- 没有声称 CPIR 超越 constrained POMDP；旧 runner 的相同结果仍然有效，反而支持把 planner 降级为 policy interface。

### Reviewer 视角的当前裁决

新 evaluator 消除了“hard safety 由 `safeByWorld` 直接注入”的一部分方法漏洞，并修复了 action 类型绕过、写入/terminal reconcile、裸 finality、跨 intent 幂等 registry、sink generation 绑定和 token replay 等反例。但它仍是 supplied typed snapshot 上的 preflight predicate，缺少 check→commit 原子线性化和真实 authority verifier。因此当前评分保持保守：新颖性约 `5.7–6.3/10`，技术深度约 `6.8–7.4/10`，Web 适配度约 `8.2–8.6/10`；总体仍为 `Borderline / Weak Reject`，不宣布 WWW-ready。

### 下一轮最小任务

1. 为 S1–S6 生成 typed snapshot catalog，并让新 evaluator 接管独立 runner；
2. 基于 obligation witness 实现 inclusion-minimal 高阶 conflict/blockage registry；
3. 生成完整 probe closure certificate，且让强 safe-POMDP 使用同一 evaluator 做新颖性闸门。

## 第 7 轮：AdmissionToken 线性化模型与独立复核（2026-09-01）

### 本轮执行

- 新增有限 `Reserve → Consume → Finalize` transition model；引入 `stateRevision`、`bindingRevision`、`bootEpoch`、sink generation、token hash 和 receipt ledger。
- 补齐 token identity：browser profile、OAuth issuer/subject/audience/scope digest、tenant revision、session/oauth epoch、API version fence。
- 修复并同步测试 fixture；最终 `node docs/ubuddy-cpir-web-admission-transition-v0.test.mjs` 输出 `allPassed=true, caseCount=34`。
- 新增 sink invariant audit：receipt↔token 全字段绑定、token hash 可重算、key/token 状态、effect cardinality、commit high-watermark。
- 未改 Janus/uBuddy runtime；旧 independent runner 仍保持 72 rows 的回归状态。

### 独立 Agent 复核

#### Innovation A（Web 场景）

提出 CLAT、RLF、AECF 和 timestamp/sequence hybrid 四个候选。结论是 race/ABA、receipt loss 和 browser→OAuth→tenant→API→sink identity 是真实 Web 特异问题，但每个候选都必须与 OAuth/DPoP、ETag/CAS、idempotency/outbox、signed receipt baseline 做等价性排雷。

#### Technical A（形式化）

提出 Labeled Admission Transition System、Admit/Goal 二层语义、Atomic Reserve–Consume–Commit、Epoch/Fencing ABA non-revival、有界并发验证五个深化方向。要求 P2 使用 `step(registry,state,event)` 输出 transition、pre/post hash、CAS revision、witness、post-ledger delta；`UNKNOWN` 只能进入 blockage，不能进 hard conflict。

#### Reviewer B（技术严谨性）

独立复核暴露并推动修复了 stale fixture、future-issued token、sink generation TOCTOU、伪造 finality、cross-binding receipt、调用方抬高 cardinality 和 epoch rollback。修正后 29/29 通过，但当前仍是有限单进程模型。主要 blocker：跨进程事务未证明、cryptographic provenance 未验证、旧 receipt/generation 的完整性需要持续 mutation testing。评分仍保守维持在新颖性 `6.6–6.9/10`、技术深度 `7.0–7.4/10`、Web 适配度 `7.8–8.3/10`、实验可信度 `5.4/10`，倾向 `Borderline / Weak Reject`。

### 采纳与降级

采纳：stateRevision CAS-like interface、authority vector、token replay/ABA/fence race、receipt finality evidence、Admit/Goal 分离、sink invariant audit。

降级：不得称真实 atomic consume、exactly-once、签名 token、真实 finality、runtime safety、严格超越成熟协议组合。当前最准确表述是 `finite cross-plane admission transition specification + proof-carrying effect ledger interface`。

### 下一轮最小任务

1. 将 `createAtomicSinkStore` 抽象成可枚举并发 history，验证两个 stale snapshot 只有一个可线性化；
2. 把 S1–S6 至少三个场景转换成 typed snapshot + immutable contract registry，开始接入新 evaluator；
3. 实现 P2 的 `SafeTerminalSet`、inclusion-minimal conflict/blockage registry，补三元 edge、unknown singleton 和 infeasible singleton 反例。

### 综合裁决

本轮没有宣布新的主算法，也没有把单进程 CAS-like store 夸大成真实分布式原子性。保留的核心技术对象是：

```text
Web evidence cut → immutable contract-bound token
→ revision/epoch guarded consume
→ receipt finality refinement
→ auditable Admit/Goal + conflict/blockage witness
```

最强的新颖性候选是“跨来源可提交一致切面 + non-revival token + receipt-loss-safe finality”的统一 Web effect identity；最强反驳仍是成熟 OAuth/DPoP、ETag/CAS、idempotency/outbox、signed receipt 的组合可能复现同样行为。下一轮必须以公平 baseline 和最小 paired traces 证伪，而不是继续增加术语。

### 三条最小 paired trace（planned P2 benchmark）

1. `reserve → consume(commit) → response drop`：提交已发生但客户端未知；盲 retry 应产生 duplicate，正确策略只能 reconcile/UNKNOWN。
2. `reserve@fence-A → rotate B → rotate A → delayed consume`：值回到 A 但 revision/epoch 已变；旧 token 必须 non-revival。
3. `Tab-A/Tab-B same key → delayed messages → concurrent retry`：只有一个 reserve/consume 可线性化，另一侧只能 NO_OP/RECONCILE。

基线必须至少包括：OAuth/DPoP + ETag/If-Match + server idempotency + transactional outbox（B0）、B0 加 atomic registry（B1）、CACE-only、RFRE-only 和完整方法；各基线拥有相同 probe、故障和重试预算，不能读取 hidden ledger。

### 三位独立 Reviewer 最终评分

| Reviewer | 新颖性 | 技术深度 | Web 适配度 | 实验可信度 | 倾向 |
|---|---:|---:|---:|---:|---|
| Reviewer A：WWW 新颖性 | 5.0 | 6.1 | 7.8 | 4.2 | Weak Reject / Borderline |
| Reviewer B：技术严谨性 | 6.5 | 6.8 | 8.0 | 5.2 | Borderline / Weak Reject |
| Reviewer C：成熟组合可替代性 | 6.2 | 7.4 | 8.1 | 6.0 | Borderline / Weak Reject |

一票否决仍存在：在单一可信 gateway + transactional sink 环境下，`OAuth/DPoP ∧ tenant ACL ∧ If-Match/CAS ∧ idempotent transaction ∧ outbox ∧ signed status receipt` 基本可实现当前 safety 主链。综合 Agent 不宣布 WWW-ready。

### Reviewer 意见采纳后的实现修正

- replay 在返回原 receipt 的 `NO_OP` 前先校验 action identity 与 contract digest；错误 tenant/action 不再享受幂等 replay。
- sink audit 新增 receipt state enum、receipt↔token↔immutable registry、`cardinalityAfter` 和 contract digest 检查。
- 新增统一 `step(state,event,registry)`，输出 `APPLY/STUTTER/REJECT/UNKNOWN`、pre/post state hash、revision 和 linearization witness；未知/拒绝保持 state hash 不变。
- admission transition 回归扩展到 34 cases，全部通过。

### 本轮最终裁决

不重做整个方向，但进一步缩小主创新边界：

1. 单一可信协调域：承认可以编译为成熟 stack，作为负向等价边界；
2. 多独立 authority、无共同事务边界：研究 VCC/PREE 的 fractured-cut、UNKNOWN 和 proof witness；
3. post-linearization receipt 不可权威即时查询：研究 TSRF 的 conflict/blockage 和 no-false-terminalization；
4. browser 生命周期只保留 BFF 无法覆盖的 BFCache/SW/multi-partition intent lineage 场景。

当前综合评分维持：新颖性 `5.6–6.3/10`，技术深度 `6.8–7.4/10`，Web 适配度 `7.9–8.4/10`，实验可信度 `4.8–5.8/10`，倾向 `Weak Reject / Borderline`。

### P0/P1 独立复核结果

| 复核角色 | 新颖性/潜力 | 技术深度 | 结论 |
|---|---:|---:|---|
| WWW 新颖性 | 5.5 | 6.4 | 当前仍像 OAuth/tenant/ETag/idempotency/receipt 的统一协议组合；新意要靠跨 plane 原子 effect identity 和不可替代 witness 证明 |
| 技术严谨性 | — | 5.6 | snapshot predicate 比 fixture lookup 深，但 action typing、reconcile、registry/receipt binding 与 transition guard 曾有可复现漏洞 |
| 形式化复核 | 6.7–7.0 潜力 | 方法 7.4 / 执行语义 5.8 | obligation witness 足以作为 P2 原子，但必须拆分 `Admit` 与 `Goal`，并加入 successor/atomic sink transition |
| 协议 Reviewer（修正后复跑） | 6.1 | 7.0 | 26-case 语义更稳，但 AdmissionToken 尚未由 sink 原子 consume，仍是 Borderline / Weak Reject |

采纳并已修正：typed action validation、effectful action 判定、OAuth expiry、idempotence registry owner、receipt issuer/signature/versionFence/generation/high-watermark/trusted clock、RFRE authoritative transition guard、read-only reconcile 非 terminal、compensation 递归 forward contract。

拒绝一项误报：两位 Reviewer 最初认为裸 `NO_COMMIT/FINAL_VERIFIED` 会绕过 `receiptCoherent`；复跑后确认该对象会先返回 `UNKNOWN`，不会 fallback 为 `SAFE`。该指控不进入 blocker。

仍保留的一票否决：没有原子 compare-and-consume transition，CACE-IL 目前只能称 preflight admission predicate；强 safe-POMDP 与同一 verifier 的不可替代性仍未建立。

## 第 8 轮：Admission-derived conflict/blockage registry（2026-09-01）

### 本轮执行

- 先复跑 `ubuddy-cpir-web-conflict-registry-v0.test.mjs`：5/5 通过，覆盖高阶最小冲突、UNKNOWN blockage、不可行 singleton 和等价 world duplication invariance。
- 新增 `ubuddy-cpir-web-admission-conflict-adapter-v0.mjs`，把 registry 的 evaluator 接到真实的有限 admission transition。每个 action plan 都按 `RESERVE → CONSUME → FINALIZE` 运行；拒绝/未知结果转换为 obligation-level witness，terminal safe 还必须通过 `auditSinkState`。
- 新增 `ubuddy-cpir-web-admission-conflict-adapter-v0.test.mjs`：初版 4/4 通过，复核修正后扩展为 10/10。两个仅 version-fence 不同的 hidden worlds 产生二元 `HARD_CONFLICT`；缺失 immutable contract 产生 `EPISTEMIC_BLOCKAGE`；错误 digest 产生 `INFEASIBLE` singleton。
- 全量回归：26 个 typed evaluator、34 个 admission transition、5 个 conflict registry、10 个 adapter case 全部通过。

### 新颖性/技术深度裁决

这一步的实质增量不是再加一个图结构，而是把“跨 plane effect admission”与“高阶 conflict/blockage certificate”接成同一可执行语义链：

```text
typed world → reserve/consume/finalize transition → obligation witness
→ terminal verdict → minimal conflict/blockage registry
```

因此可以开始主张一个较窄但可证伪的技术对象：**admission-derived Web effect conflict certificate**。它能表达版本 fence 分裂、authority epoch 变化和 receipt finality 失败导致的 action-level 冲突，而不是仅把 fixture safety table 画成 hypergraph。

### 仍不能主张的内容

- 适配器仍是单进程、内存态、有限 world catalog；不能称真实分布式事务或 runtime safety。
- 不能称 exactly-once、cryptographic attestation、真实 OAuth/sink authenticity 或 authoritative finality。
- 该结果仍未证明 CPIR planner 严格超越 constrained POMDP；当前新颖性主张应限定为 Web contract semantics、transition-derived certificate 和 fail-closed interface。

### 下一步

1. 将 adapter 输出扩展为完整 probe closure certificate：public cut、支持集、terminal cells、剩余 budget/depth、rejected-action witness 和 closure status。
2. 为同一 transition relation 加入成熟组合 baseline（OAuth/DPoP、tenant ACL、ETag/CAS、idempotency/outbox、signed receipt），检查 certificate 是否提供额外诊断价值。
3. 只有在 certificate 与 baseline 行为不等价时，才恢复更强的算法新颖性主张；否则将方法定位为 Web effect-contract formalization + auditable protocol/benchmark。

### 独立复核后立即修正

- 移除 adapter 的隐式 finality oracle：默认不再自动把 `COMMITTED` 填成 authoritative/signed/trusted finality；只有显式的测试模式 `BIND_OBSERVED_RECEIPT_TEST_ONLY` 才绑定刚生成 receipt。缺失证据现在保持 `UNKNOWN/RFRE`。
- revision 来源显式化：计划默认要求 `expectedStateRevision`；只有标注 `GATEWAY_AT_EVENT` 才允许在事件线性化点读取当前 revision，避免 adapter 把 stale probe 隐藏成“当前状态”。
- audit 失败现在进入 `EFFECT_LEDGER_AUDIT` obligation witness；不会再出现 `audit=VIOLATED` 但 evaluation 没有 rejected/unknown witness 的空证书。
- conflict registry 将 world 子集枚举限制为显式 `maxWorldClasses`（默认 20），修复 JavaScript 32 位位移在 world≥31 时的错误；增加 `MIXED_OBSTRUCTION` 记录，避免混合未知/违例被静默丢弃。hard conflict 还显式排除包含 UNKNOWN 的 action/world matrix；测试扩展为 10/10。

### 修正后的独立评分

- Novelty：`6.1/10`（只小幅上调；仍受成熟协议组合可替代性约束）；
- Technical depth：`7.5/10`（因 finality/revision/audit/mixed-obstruction 语义闭合而上调）；
- 接收倾向：`Borderline / Weak Reject`，不宣布 WWW-ready。

该评分变化属于严谨性和可证伪性改进，不是新算法能力证明。若 VCC/PREE 仍未实现，或成熟组合使用同一 verifier 后产生相同 trace/certificate，主张必须固定为 Web typed protocol composition/interface。

## 第 9 轮：VCC/PREE evidence cut 初版与独立否决（2026-09-01）

### 本轮执行结果

- 新增 `ubuddy-cpir-web-vcc-pree-v0.mjs` 和测试；实现 evidence atom、canonical VCC、PREE escrow、reserve-time reconstruction/revalidation。
- 15/15 断言通过，覆盖 coherent/fractured cut、依赖 revision、scope/owner、effect/tenant binding、stale/expired evidence、forged cut、atom collision、signature-unverified、bounded search 和 escrow-store replay。
- 代码只在 `docs/` 新增研究工件；未修改 Janus/uBuddy runtime、API、schema 或既有实验实现。

### 三类独立评审结论

#### Web 创新复核

提出 AS-BCC、CCMAC、PCBE、ACRE 四个候选。优先级为：CCMAC 最直接打 fractured read；AS-BCC/PCBE 的 Web 特异性最强；ACRE 并入 RFRE。共同要求是不能把 pageEpoch、nonce 或 vector clock 单独包装成创新。

#### 技术形式化复核

确认当前核心漏洞已修复：reserve 需重建 cut、验证 atom 当前有效、绑定 effect/tenant、检查 source coverage 和 escrow revision。指出 unary 语义不需要笛卡尔积，已新增 `UNARY_CANONICAL` 默认与显式 `CARTESIAN` bounded mode。仍保留 authority authenticity、predecessor dependency graph、跨进程原子 escrow 为未实现假设。

#### 严格 WWW 评审

评分：新颖性 `5.8/10`，技术深度 `6.6/10`，Web 适配度 `8.2/10`，实验可信度 `3.8/10`；倾向 `Weak Reject / Borderline`。三项主要否决：

1. 成熟 OAuth/DPoP + ACL + ETag/CAS + idempotency/outbox + signed receipt 仍可能复现行为；
2. authority/signature 目前是布尔输入，非真实证据验证；
3. escrow clone-return 不是跨进程 durable atomic consume，且尚无 BFCache/SW/fractured-read paired replay。

### 采纳与拒绝

- 采纳：cut 从 escrow atom 重建、reserve-time validity、effect/tenant/session/challenge binding、explicit escrow revision、bounded complexity 和 fail-closed unknown。
- 拒绝：把 interval intersection、schema 字段、authorityId、nonce 或 Cartesian search 本身作为新颖性；把有限单进程 store 叫作真实 PREE transaction。

### 本轮裁决与下一步

本轮只提高了语义严谨性和可证伪性，不提高总体新颖性。当前综合评分保持：新颖性 `5.8–6.1/10`，技术深度 `7.3–7.6/10`，Web 适配度 `8.1–8.4/10`，倾向 `Borderline / Weak Reject`。

下一轮三个可执行任务：

1. 加入 `tabEpoch/pageEpoch/swEpoch/activationNonce` 的最小生命周期撤销模型；
2. 加入 OAuth→tenant→API→sink predecessor/dependency edge，构造 consistent-cut 与 fractured-cut paired worlds；
3. 用同一 transition verifier 实现成熟组合 baseline，若 trace/certificate 等价则停止新算法主张。

## 第 10 轮：ABCA activation profile 与独立复核（2026-09-01）

### 本轮执行

- 读取并执行目标文件，继续保持 active；未修改 Janus/uBuddy runtime。
- VCC/PREE 从单纯 source/interval cut 扩展为 activation-bound profile：atom、cut、escrow、reserve 均绑定 browser activation vector。
- 新增 `advanceActivation` 与 current-activation reserve revalidation；测试扩展至 17/17。
- 修正默认复杂度为 unary canonical filtering，显式 Cartesian 模式有 `maxCandidateCombinations` 上界；避免把不必要的指数搜索包装成技术贡献。

### 独立复核评分与裁决

本轮复核给出的保守判断：VCC/PREE/ABCA 当前新颖性约 `5.8–6.2/10`，技术深度约 `6.6–7.6/10`，Web 适配度约 `8.2/10`，仍为 `Borderline / Weak Reject`。技术严谨性有所提高，但新颖度不应因正确性修补而显著上调。

必须保留的替代性边界：

1. 若强 baseline 也绑定 activation lineage、predecessor/revocation、escrow reconstruction 和 reserve-time revalidation，则 ABCA 可能只是协议编译/接口；
2. 若 safe POMDP/consistent snapshot 使用同一 verifier，DRAS/AOC/PBES 不得宣称表达能力超越；
3. `signatureVerified`、authority key、durable escrow、sink linearization 仍是未实现 trust/transaction 假设。

### 下轮研究闸门

只实现四类 locked pair：AL、PC、ER、AN。每类同时提供正例和负例，使用独立 transition oracle 生成 gold。若候选与强成熟组合在 verdict、linearization witness、certificate projection 上 trace-equivalent，立即停止独立新协议/新 planner 叙事，保留 Web typed formalization/interface。

## 第 11 轮：PC pair 执行与主张降级（2026-09-01）

### Reviewer 评分

| Reviewer | 新颖性 | 技术深度 | Web 适配度 | 实验可信度 | 倾向 |
|---|---:|---:|---:|---:|---|
| WWW 新颖性 | 5.7 | 6.8 | 8.4 | 4.1 | Weak Reject / Borderline |
| 技术严谨性 | 5.9 | 6.7 | 8.3 | 4.1 | Borderline / Weak Reject |
| 成熟组合可替代性 | 4.8 | 6.6 | 8.5 | 3.8 | Weak Reject |

共同 veto：没有真实 authority verifier、predecessor DAG、durable escrow/sink linearization，以及同证据/同 verifier 的完整强 baseline 实验。DRAS/AOC 仍是名称和目标，不是已实现算法。

### PC pair 实际结果

- `PC+` 与 `PC-` 具有相同 public observation；独立 authority log oracle 分别给 `SAFE/REJECTED`。
- 常见局部 freshness baseline 对两者均 SAFE，产生一个 false accept。
- ABCA predecessor closure 正确区分并给出 revoke frontier witness。
- 强成熟组合加入相同 causal frontier verifier 后与 ABCA 完全等价。

### 综合裁决

采纳 Reviewer 的停止规则：ABCA 不再作为当前不可替代新协议；定位降为 `finite Web activation/evidence admission profile + falsification benchmark`。继续研究的唯一合理算法出口是：

1. AOC 是否能比 generic MUS/MaxSAT 更高效地产生三值、可重放的最小 obstruction；
2. DRAS 是否能利用 revision/expiry 偏序与 antichain 获得可证明的求解优势。

若这两个闸门也与通用 solver 等价，则停止算法新颖性路线，保留 formalization/interface/benchmark。

## 第 12 轮：AOC/locked-pair 复核与 observation-aware DP（2026-09-01）

### 本轮工件

- `ubuddy-cpir-web-aoc-deletion-baseline-v0.mjs`：generic deletion-MUS baseline；6/6，通过并与 exhaustive registry core 相同，构成 AOC wrapper 的负新颖性证据。
- `ubuddy-cpir-web-aoc-verifier-v0.mjs`：replay/minimality gate；AOC 总测试 6/6，但仍依赖同 evaluator，定位为 interface/checker。
- `ubuddy-cpir-web-aoc-dp-v1.mjs`：observation-aware bounded DP；8/8，输出 losing probe/child witness。
- AL/ER/AN locked pair：10/10；VCC/PREE：18/18；其余 admission/conflict/evaluator 回归全部通过。

### 独立意见

- Web 复核：AL 最具 Web 特异性；ER 最容易被事务/outbox 替代；AN 的异步不可观测场景清晰但机制通用；AOC 价值主要是 effect witness 接口。
- 算法复核：AOC wrapper 淘汰；AOC-CEGAR/DRAS 仅条件保留；observation-aware DP 是正确算法对象，但默认等价于 bounded POMDP。
- 理论复核：AN 优先级高于 AL、ER；只有 conflict-hypergraph/probe-cover duality、activation path compositionality 或 concrete refinement 在强 baseline 下显示差异，才有理论主张空间。

### 当前评分与裁决

综合建议：Novelty `5.7–5.9/10`，Technical depth `6.8–7.1/10`，Web fit `8.4–8.5/10`，Credibility `4.1–4.6/10`；倾向仍 `Weak Reject / Borderline`。AOC-DP 提升语义正确性，但没有证明 planner 表达力新颖。

下一轮必须做强 baseline 闸门：robust-POMDP/model-checking/deletion-MUS 与候选共享 candidate-independent oracle、world/action/probe manifest、fault schedule、trust roots 和 budget；比较 verdict、projected certificate、状态展开、oracle calls 和成本。若 bounded trace 等价，停止算法新颖性主张。

## 第 13 轮：三方复核后的最终收敛（2026-09-01）

### 本轮评分

| Reviewer | 新颖性 | 技术深度 | Web 适配度 | 实验可信度 | 倾向 |
|---|---:|---:|---:|---:|---|
| Web 新颖性 | 5.8 | 6.9 | 8.5 | 4.5 | Weak Reject / Borderline |
| 技术严谨性 | 5.9 | 7.0 | 8.4 | 4.6 | Weak Reject / Borderline |
| 成熟组合替代性 | 5.2 | 7.1 | 8.4 | 4.4 | Weak Reject |

### 采纳的负结论

- AOC wrapper 与 deletion-MUS 得到相同静态 core，不作为新算法。
- AOC-DP 的 belief-cell recursion 是正确的算法对象，但可由 bounded constrained POMDP 表达，不能宣称 planner 表达力优势。
- AL/ER/AN pair 目前仍是 toy fixture：AL baseline 硬编码、ER 无 crash/durable oracle、AN 无独立 observation projector；PC strongest baseline 与 ABCA 共享 closure evaluator。

### 当前保留主张

只保留：`finite activation-aware Web effect admission + observation-cell fail-closed abstention + replayable obstruction witness interface`。这是一种 Web-specific formalization/certificate profile，尚未是不可替代协议或算法。

### 必须完成的 oracle-v1 闸门

1. 独立、纯、确定、candidate-independent transition oracle；
2. 固定 world/action/probe/fault manifest、trust roots、observation projector 和预算；
3. AL/PC/ER/AN 正负 pair 与关键双故障 exhaustive bounded replay；
4. AOC-DP、deletion-MUS、robust-POMDP、强成熟组合共享同一 oracle，比较 verdict、linearization witness、certificate projection、状态展开和成本；
5. timeout/bound/不完整证据一律 `UNKNOWN`，不得作为 SAFE。

停止条件不变：若 bounded trace 上候选与强 baseline/POMDP 等价，停止独立算法/协议新颖性叙事，保留 Web typed formalization、certificate interface 和 benchmark。

## 第 14 轮：oracle-v1 实施与严格复核（2026-09-01）

### 执行结果

- 新增 `ubuddy-cpir-web-oracle-v1.mjs`、schema、example 和 `16/16` 测试；oracle 为纯、确定、总的 finite manifest evaluator，异常归 `UNKNOWN`。
- oracle 不允许预填 `safeByWorld/actionResults/probeResults`，action verdict 由 guard/transition DSL 推导，probe 只允许 read-only projection。
- 新增 oracle-only AOC-DP adapter，`6/6`；原 AOC-DP 改为拒绝 arbitrary callbacks 和 hidden world objects，`8/8`。
- 未修改 Janus/uBuddy runtime、API、数据库 schema 或既有实验实现；新增内容均为 `research-prototype/unverified`。

### 审稿裁决

oracle-v1 修复了 candidate-dependent evaluator 这一关键实验漏洞，但没有解决三项一票否决：真实 browser/authority/durable sink 仍缺失；强成熟组合和 robust-POMDP 尚未在同一 oracle 上运行；AOC-DP 的 policy/value/复杂度优势仍未建立。因此不提高新颖性评分，也不宣布 WWW-ready。

当前保守评分：新颖性 `5.8–6.0`、技术深度 `7.0–7.3`、Web 适配度 `8.3–8.5`、实验可信度 `4.8–5.2`，倾向 `Weak Reject / Borderline`。

### 下一轮最小任务

1. AL/PC/ER/AN 全部转成 oracle guard/transition manifest；
2. 实现共享 oracle 的 robust-POMDP/model checker 与 strong mature Web baseline；
3. 运行 trace/certificate equivalence 和资源成本对比，并严格执行停止条件。

### Pair 编译补充

四类 locked pair 已通过共享 oracle DSL 的 `26/26` 测试；这提升了 paired-world 可复现性，但仍不提高新颖性评分。当前最大风险仍是：声明 world state 与真实 Web authority/sink 之间存在未验证鸿沟，以及强成熟组合/POMDP 尚未共享该 oracle 做等价性对照。

### Shared-oracle baseline 复核

- 独立 robust belief-state checker 与 AOC-DP 在 winning fixture 上 policy/memo-state 等价；
- 在 AL/PC/ER/AN 统一 manifest 上 bounded policy 结论等价；
- strongest mature profile 使用同 verifier 时 verdict/linearization/sink-delta trace-equivalent；
- 10/10 比较断言通过，构成负新颖性证据。

综合裁决：采纳停止条件，AOC-DP、DRAS 和 ABCA 不再作为独立算法/协议创新。当前定位收敛为 Web typed formalization、certificate interface 与 falsification benchmark；新颖性保守调整为 `5.4–5.8/10`，倾向仍为 `Weak Reject / Borderline`。下一步不再开发同构 solver，而转向真实 adapter、certificate information advantage 和 benchmark coverage。

### Certificate information review

共享 oracle 上，CPIR 与 generic/mature full projection 完全等价；native trace/audit 的差异只是字段覆盖，MUS core 无法完整 replay transition。故当前没有证据支持“证书内在信息优势”，仅支持标准化、可重放接口价值。后续若无法在相同 typed projection 下获得严格 replay/最小性/成本优势，应维持 Web formalization + benchmark 定位。

### Double-fault review

AL+PC、AL+AN、PC+ER、ER+AN 双故障覆盖 `17/17`，多项 violated guard witness 可重放，timeout fail-closed。该结果提升 benchmark 可信度和 obstruction closure，但仍属于有限声明模型；没有改变 full typed projection 与成熟 baseline 的等价性，也没有消除真实 browser/authority/durable sink blocker。

### Durable harness review

独立 SQLite/WAL harness 与真实子进程测试 `29/29`，证明了本地 crash/reopen、CAS stale、rollback 和 replay 语义。该证据可把 ER 从纯 fixture 提升为更强的研究原型，但仍不能外推到外部 Web sink exactly-once、真实签名或跨服务事务；因此只小幅提高技术可信度，不提高新颖性评分。

### Signed authority review

Ed25519 signed event log 测试 `12/12`，消除了 PC pair 中裸 `signatureVerified` 的一部分自证风险；但它仍是本地 authority 原型，不覆盖真实 OAuth introspection/consent/key lifecycle，也没有改变成熟组件可复现性结论。技术深度可小幅上调，创新评分不变。
