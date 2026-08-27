CREATE TABLE IF NOT EXISTS public.ubuddy_org_trace_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  evolution_namespace text NOT NULL DEFAULT 'default',
  trace_id text NOT NULL,
  event_kind text NOT NULL,
  task_type text NOT NULL DEFAULT '',
  task_signature text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, evolution_namespace, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.ubuddy_org_policy_versions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  evolution_namespace text NOT NULL DEFAULT 'default',
  parent_policy_version_id text NOT NULL DEFAULT '',
  policy_hash text NOT NULL,
  stage text NOT NULL DEFAULT 'shadow',
  playbook_json jsonb NOT NULL,
  baseline_score double precision NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'candidate',
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  disabled_at timestamptz,
  UNIQUE(owner_user_id, evolution_namespace, policy_hash)
);

CREATE TABLE IF NOT EXISTS public.ubuddy_org_policy_health_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  evolution_namespace text NOT NULL DEFAULT 'default',
  policy_version_id text NOT NULL,
  trace_id text NOT NULL DEFAULT '',
  event_kind text NOT NULL,
  idempotency_key text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, evolution_namespace, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ubuddy_org_trace_owner_created_idx ON public.ubuddy_org_trace_events(owner_user_id, evolution_namespace, created_at);
CREATE INDEX IF NOT EXISTS ubuddy_org_policy_owner_status_idx ON public.ubuddy_org_policy_versions(owner_user_id, evolution_namespace, status, created_at DESC);
