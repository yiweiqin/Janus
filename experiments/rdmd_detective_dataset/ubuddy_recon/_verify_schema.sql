-- Verification schema for the uBuddy recon pipeline.
--
-- This creates ONLY the tables export_ubuddy_task_samples.mjs touches, using the exact column
-- definitions from the real DDL:
--   collaboration_graph_*         cloud/database/migrations/094_ubuddy_collaboration_graph.sql
--   cloud_task_runs/_nodes        cloud/test/fixtures/pg-mem-baseline.sql
--   task_node_result_versions     cloud/test/fixtures/pg-mem-baseline.sql
--
-- GRANTs from 094 are omitted (they need the janus_api/janus_migrator roles). This instance exists
-- to prove the export SQL and the analyzer run against real PostgreSQL semantics, not to be a full
-- schema replica. That distinction is recorded in the recon report.

CREATE TABLE collaboration_graphs (
  id text PRIMARY KEY,
  graph_version text NOT NULL DEFAULT 'ubuddy_collaboration_graph_v1',
  root_task_run_id text NOT NULL DEFAULT '',
  root_delegation_id text NOT NULL DEFAULT '',
  root_group_id text NOT NULL DEFAULT '',
  root_node_id text NOT NULL,
  owner_workspace_id text NOT NULL DEFAULT 'workspace_personal',
  owner_user_id text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  current_revision bigint NOT NULL DEFAULT 0,
  lifecycle_status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collaboration_graph_nodes (
  graph_id text NOT NULL REFERENCES collaboration_graphs(id) ON DELETE CASCADE,
  node_id text NOT NULL,
  parent_node_id text NOT NULL DEFAULT '',
  kind text NOT NULL,
  task_run_id text NOT NULL DEFAULT '',
  delegation_id text NOT NULL DEFAULT '',
  task_node_id text NOT NULL DEFAULT '',
  owner_user_id text NOT NULL DEFAULT '',
  owner_agent_id text NOT NULL DEFAULT '',
  owner_agent_instance_id text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  public_summary text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued',
  progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  depth integer NOT NULL DEFAULT 0 CHECK(depth BETWEEN 0 AND 2),
  visibility text NOT NULL DEFAULT 'participants',
  public_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(graph_id,node_id)
);

CREATE TABLE collaboration_graph_edges (
  graph_id text NOT NULL REFERENCES collaboration_graphs(id) ON DELETE CASCADE,
  edge_id text NOT NULL,
  kind text NOT NULL,
  from_node_id text NOT NULL,
  to_node_id text NOT NULL,
  public_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(graph_id,edge_id),
  UNIQUE(graph_id,kind,from_node_id,to_node_id)
);

CREATE TABLE collaboration_graph_events (
  graph_id text NOT NULL REFERENCES collaboration_graphs(id) ON DELETE CASCADE,
  graph_revision bigint NOT NULL,
  event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  node_id text NOT NULL DEFAULT '',
  public_patch_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id text NOT NULL DEFAULT '',
  actor_agent_instance_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(graph_id,graph_revision)
);

CREATE TABLE cloud_task_runs (
  id text NOT NULL PRIMARY KEY,
  owner_user_id text DEFAULT ''::text NOT NULL,
  payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  account_workspace_id text DEFAULT 'workspace_personal'::text NOT NULL
);

CREATE TABLE cloud_task_nodes (
  id text NOT NULL PRIMARY KEY,
  task_run_id text DEFAULT ''::text NOT NULL,
  user_agent_instance_id text DEFAULT ''::text NOT NULL,
  payload_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE task_node_result_versions (
  id text NOT NULL PRIMARY KEY,
  task_run_id text NOT NULL,
  task_node_id text NOT NULL,
  graph_revision_id text DEFAULT ''::text NOT NULL,
  version_no integer DEFAULT 1 NOT NULL,
  result_text text DEFAULT ''::text NOT NULL,
  result_summary text DEFAULT ''::text NOT NULL,
  evidence_json jsonb DEFAULT '[]'::jsonb NOT NULL,
  decision text DEFAULT 'pending'::text NOT NULL,
  decision_reason text DEFAULT ''::text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  decided_at timestamptz
);
