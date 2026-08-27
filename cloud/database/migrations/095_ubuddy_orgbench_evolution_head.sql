-- Additive migration marker for the completed OrgBench organization-evolution
-- schema.  Earlier additive migrations create the tables and trace link; this
-- marker ensures readiness checks have a monotonic head after migration 094.
CREATE INDEX IF NOT EXISTS ubuddy_org_policy_parent_idx
  ON public.ubuddy_org_policy_versions(owner_user_id, evolution_namespace, parent_policy_version_id);
