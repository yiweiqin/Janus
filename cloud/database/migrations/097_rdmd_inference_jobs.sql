-- RDMD 云侧推理作业表（P4）。
--
-- 形状照抄 cloud_evolution_jobs：status / attempt_count / available_at / claimed_by /
-- lease_expires_at。这不是巧合，是刻意的 —— GPU 盒与云 API 之间只有**出站**连接
-- （AutoDL 不开入站端口、不用隧道），所以只能由 GPU 侧主动来领活，而"抢占 + 租约 + 退避"
-- 正是这种拓扑下唯一能扛住 worker 掉线/重启的形态。既然模式一样，就没有理由另发明一套。
--
-- 与 cloud_evolution_jobs 的差别只有三处，都是 RDMD 特有的：
--
--   1. **载荷在这里，结果也在这里**。进化作业的输入是已加密的证据（在别处），产出是一次
--      对 Memory 的写入；RDMD 的输入是一条 case（两张图），产出是一个判定。所以作业行自带
--      `case_json` 与 `verdict_json`，不需要再引一张 runs 表 —— 一个作业就是一个 case，
--      没有"多作业共享一次运行上下文"这回事。
--
--   2. **`verdict_json` 必须带出处**。P4 的硬要求是"判定要带出处，否则记录不可审计"：
--      adapter sha256、base model id、契约版本、规则版本。它们不是一个 JSON blob 里的自由字段，
--      而是列 —— 因为它们是**查询维度**（"哪一版 adapter 的判定开始变差"必须能直接 WHERE），
--      塞进 jsonb 就查不动了。
--
--   3. **隐私：`case_json` 里只允许出现白名单字段**。落库的是**过滤后**的载荷，不是原始
--      图。发送到云本身就是一次质变式的暴露（本地读库 → 数据离开设备），所以
--      `payload_json` 由 `rdmd/privacy.mjs` 的显式白名单生成，且 `private_assistant`
--      会话在**入队前**就拒绝（不是靠事后过滤）。这里不做约束，约束在应用层，
--      因为白名单本身需要跟着契约版本演进，写死进 SQL 会让每次契约变更都要迁移。

CREATE TABLE IF NOT EXISTS public.cloud_rdmd_inference_jobs (
    id text NOT NULL,
    -- 作业归属：发起任务的用户。它有两个**真实**用途 ——
    --   1. 去重键的一半（见下面 uq_cloud_rdmd_jobs_open_task_run）；
    --   2. `read()` 的作用域（桌面端只允许读自己的作业）。
    -- **不要**指望用它来限制 worker 回传：worker 是一个跨用户的服务身份
    -- （scripts/_rdmd_worker_provision.mjs），它替所有用户领活与回传判定，
    -- 所以 grant 的用户与这里**天然不等**。回传侧的越权面收在**签发端**，
    -- 见 cloud/src/modules/sync/deviceGrants.mjs#SERVICE_ONLY_SCOPES：
    -- `rdmd:infer` 只签给配置在册的服务身份，普通用户自取不到。
    owner_user_id text NOT NULL,
    -- 去重键：同一个 task run 在同一次终态上可能被重复提交（notifyTaskUpdated 会在终态上被多次调用）。
    -- 唯一索引保证"一次 task run 只入队一个作业"，重放命中同一行。
    task_run_id text DEFAULT ''::text NOT NULL,
    case_hash text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 2 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_by text DEFAULT ''::text NOT NULL,
    claimed_at timestamp with time zone,
    lease_expires_at timestamp with time zone,
    error_code text DEFAULT ''::text NOT NULL,
    error_text text DEFAULT ''::text NOT NULL,
    -- 过滤后的 case 载荷（见 rdmd/privacy.mjs#buildRdmdCloudPayload 的白名单）。
    case_json jsonb NOT NULL,
    verdict_json jsonb,
    -- 出处。缺任何一列都不许写 verdict（应用层强制），否则这条判定无从追责。
    adapter_sha256 text DEFAULT ''::text NOT NULL,
    base_model_id text DEFAULT ''::text NOT NULL,
    contract_version text DEFAULT ''::text NOT NULL,
    rule_version text DEFAULT ''::text NOT NULL,
    worker_version text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT chk_cloud_rdmd_job_attempts CHECK (((attempt_count >= 0) AND (max_attempts >= 1))),
    CONSTRAINT chk_cloud_rdmd_job_status CHECK ((status = ANY (ARRAY[
        'queued'::text, 'claimed'::text, 'running'::text,
        'completed'::text, 'unavailable'::text, 'failed_retryable'::text, 'failed_terminal'::text
    ]))),
    -- 判定与出处同生共死，**但要按终态区分**：这条约束的第一版写成"有 verdict 就必须有
    -- 完整出处"，结果把空后端（null backend）的正常终态也挡了 —— 它产出 UNKNOWN +
    -- reason=model_not_configured，而"没有模型"这件事本来就没有 adapter 可指认。
    --
    -- 那是个真实的区分，不是形式问题：`completed` 是**模型判定**，必须能追到某一版 adapter；
    -- `unavailable` 是**没有模型**这个事实的显式记录，出处必须为空（声明了 adapter 却说
    -- 不可用是自相矛盾）。其余状态不许有 verdict。这样反而比原来更严：
    -- 它额外禁止了"unavailable 但自称来自某个 adapter"这种矛盾行。
    CONSTRAINT chk_cloud_rdmd_job_provenance CHECK (
        (status IN ('queued'::text, 'claimed'::text, 'running'::text, 'failed_retryable'::text, 'failed_terminal'::text)
            AND verdict_json IS NULL)
        OR (status = 'completed'::text AND verdict_json IS NOT NULL
            AND adapter_sha256 <> ''::text AND base_model_id <> ''::text AND contract_version <> ''::text)
        OR (status = 'unavailable'::text AND verdict_json IS NOT NULL
            AND adapter_sha256 = ''::text AND base_model_id = ''::text)
    )
);

CREATE INDEX IF NOT EXISTS idx_cloud_rdmd_jobs_claim
    ON public.cloud_rdmd_inference_jobs (available_at, created_at);

-- 去重：同一 task run 只留一个未完成的作业。用部分唯一索引而不是全表唯一 ——
-- 一个 task run 如果在真实数据上被反复重放（开发期很常见），历史作业要留下痕迹，
-- 只压掉"还没结束"的那些。
CREATE UNIQUE INDEX IF NOT EXISTS uq_cloud_rdmd_jobs_open_task_run
    ON public.cloud_rdmd_inference_jobs (owner_user_id, task_run_id)
    WHERE status IN ('queued'::text, 'claimed'::text, 'running'::text);

CREATE INDEX IF NOT EXISTS idx_cloud_rdmd_jobs_provenance
    ON public.cloud_rdmd_inference_jobs (adapter_sha256, base_model_id, contract_version);

-- requires-real-postgres-tail: role grants are intentionally skipped by pg-mem fixtures.
--
-- 少了这一段，表在**应用角色**眼里等于不存在：迁移用 janus_migrator 跑，建出来的表属主是
-- 它，而云 API 用 janus_api 连库 —— 没有授权就是 `permission denied for table
-- cloud_rdmd_inference_jobs`，且**只在第一次真的入队时才暴露**（迁移本身全绿）。
--
-- 为什么是 SELECT,INSERT,UPDATE 而没有 DELETE：RDMD 的作业是审计记录，任何一条终态都
-- 要留痕，代码里也没有任何删除路径。不给 DELETE 是刻意的 —— 少一项权力，就少一种
-- "判定被悄悄抹掉"的可能。这与 094 给事件表只发 SELECT,INSERT 是同一种取舍。
GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_rdmd_inference_jobs TO janus_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.cloud_rdmd_inference_jobs TO janus_migrator;
