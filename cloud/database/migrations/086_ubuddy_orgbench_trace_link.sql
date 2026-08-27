ALTER TABLE public.ubuddy_org_trace_events
  ADD COLUMN IF NOT EXISTS delegation_id text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS ubuddy_org_trace_delegation_idx
  ON public.ubuddy_org_trace_events(delegation_id, created_at);
