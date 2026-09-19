-- TPM 原始层的**申请 / 授权**两张表。
--
-- 背景（`docs/ubuddy-v4-tpm-contract.zh-CN.md`）：任务公共 memory 分三层 ——
-- foundation（G_plan/G_exec）、elevation（省检过的摘要）、raw（全部原始上下文）。
-- 前两层对参与者默认可见，**raw 默认不可见，必须走申请**：
--
--   createRawAccessRequest
--     → reviewRawAccessByAi      pass | reject | need_human
--     → reviewRawAccessByOwner   approve | deny
--     → grant（短时、只读、可撤回、可按 nodeIds 切片）
--
-- 状态机本身在 `src/shared/contracts/uBuddyTaskPublicMemory.js` 里，是纯函数、已有测试。
-- 那两份合约**没有告诉任何人申请过什么** —— 授权活在内存里，进程一退就没了，
-- 而"谁在什么时候被允许看了哪些原始节点"恰恰是这一层唯一需要留痕的东西。
-- 这就是这条迁移要补的缺口。
--
-- 两个刻意的设计选择：
--
-- 1. **申请与授权分表**。合成一张表的话，"被拒的申请"和"已发的授权"会共用一列状态，
--    于是每一条查询都要先想着过滤状态；而撤回（revoked_at）只能落在授权那一侧，
--    写在申请行上就会变成"申请被撤回了"这种没有意义的表述。
--
-- 2. **不复用 `cloud_memory_access_audits`**。那两张审计表是**读路径**的流水
--    （见合约文档：「读路径复用 work_memory_access_audits」），它们记的是"这次读被允许了吗"。
--    申请与授权是**状态**，不是流水：同一个授权会被读很多次，而申请只发生一次。
--    把状态塞进流水表，就会出现"授权存在与否要靠扫流水推断"这种无法审计的设计。
--    所以审计照样写 `cloud_work_memory_access_audits`（服务层做，见
--    `cloud/src/modules/tpm/index.mjs`），但状态住在这里。

CREATE TABLE IF NOT EXISTS public.cloud_tpm_raw_access_requests (
  -- 用合约里的 `requestId` 当主键（`tpm_req_…`），不另造一套 id ——
  -- 否则「合约里的那个申请」和「库里的那个申请」会变成两个东西。
  id text NOT NULL,
  -- 申请人的任务（投影时的 viewer.taskId）与被申请的任务。两者不同才是常态：
  -- 同一个任务内部不需要申请，直接就是参与者。
  source_task_id text NOT NULL DEFAULT '',
  target_task_id text NOT NULL DEFAULT '',
  requester_user_id text NOT NULL,
  purpose text NOT NULL DEFAULT '',
  -- 申请窗口（nodeIds）。空数组 = 没限定，被 AI 预审判为 `empty_node_window`。
  node_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- true = 只要摘录（正文会被截断）。要全文会触发更严的检查（`scope_too_wide`、
  -- `raw_contains_secrets`），所以这个开关必须落库，不能只在申请那一刻存在内存里。
  excerpt_only boolean NOT NULL DEFAULT true,
  -- AI 预审的结论与理由。**先落 AI 的结论再落 Owner 的**，两者分开存：
  -- 合起来就无法回答"有多少申请是 AI 放行、被人拦下的" —— 而那正是这套机制
  -- 值得看的一个数（AI 预审到底省了多少人的事）。
  ai_decision text NOT NULL,
  ai_reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_decision text NOT NULL DEFAULT '',
  owner_user_id text NOT NULL DEFAULT '',
  -- 派生量：rejected_by_ai | granted | denied_by_owner。
  -- 由服务层按上面两列算出来，不让调用方自己填 —— 见 `tpm/index.mjs` 的 `statusOf`。
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS public.cloud_tpm_raw_access_grants (
  id text NOT NULL,
  request_id text NOT NULL REFERENCES public.cloud_tpm_raw_access_requests(id) ON DELETE CASCADE,
  target_task_id text NOT NULL,
  grantee_user_id text NOT NULL,
  node_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  excerpt_only boolean NOT NULL DEFAULT true,
  -- 合约里 grant 自带的三个不变式。落库成列而不是 JSON 里的两个键，
  -- 是为了让"有没有出现过可写的、不可撤回的授权"可以直接 SELECT 出来。
  read_only boolean NOT NULL DEFAULT true,
  revocable boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL,
  approved_by text NOT NULL DEFAULT '',
  -- 撤回只写时间戳，不删行：删了就无法回答"它曾经被授权过"。
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- 「这个人现在对本任务有哪些有效授权」是最常问的一句（读路径每次都问）。
CREATE INDEX IF NOT EXISTS cloud_tpm_grants_grantee_idx
  ON public.cloud_tpm_raw_access_grants(grantee_user_id, target_task_id, expires_at DESC);
-- 「这个任务的申请史」—— 审计与"谁被拒过"用。
CREATE INDEX IF NOT EXISTS cloud_tpm_requests_target_idx
  ON public.cloud_tpm_raw_access_requests(target_task_id, created_at DESC);

-- requires-real-postgres-tail: role grants reference roles that pg-mem fixtures do not have.
--
-- 上面两张表和索引在 pg-mem 夹具里照建（契约测试要用它们），只有角色授权跳过 ——
-- pg-mem 没有 janus_api / janus_migrator 这些角色。
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_tpm_raw_access_requests TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_tpm_raw_access_requests TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_tpm_raw_access_requests TO janus_migrator;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_tpm_raw_access_grants TO janus_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_tpm_raw_access_grants TO janus_evolution_worker;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cloud_tpm_raw_access_grants TO janus_migrator;
