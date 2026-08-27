CREATE TABLE IF NOT EXISTS public.collaboration_graphs (
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

CREATE TABLE IF NOT EXISTS public.collaboration_graph_nodes (
  graph_id text NOT NULL REFERENCES public.collaboration_graphs(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS public.collaboration_graph_edges (
  graph_id text NOT NULL REFERENCES public.collaboration_graphs(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS public.collaboration_graph_events (
  graph_id text NOT NULL REFERENCES public.collaboration_graphs(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS collaboration_graph_root_task_idx ON public.collaboration_graphs(root_task_run_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS collaboration_graph_root_delegation_idx ON public.collaboration_graphs(root_delegation_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS collaboration_graph_root_group_idx ON public.collaboration_graphs(root_group_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS collaboration_graph_nodes_source_idx ON public.collaboration_graph_nodes(task_run_id,delegation_id,task_node_id);
CREATE INDEX IF NOT EXISTS collaboration_graph_nodes_owner_idx ON public.collaboration_graph_nodes(graph_id,owner_user_id,owner_agent_instance_id);
CREATE INDEX IF NOT EXISTS collaboration_graph_events_cursor_idx ON public.collaboration_graph_events(graph_id,graph_revision);

-- requires-real-postgres-tail: role grants are intentionally skipped by pg-mem fixtures.
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.collaboration_graphs TO janus_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.collaboration_graph_nodes TO janus_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.collaboration_graph_edges TO janus_api;
GRANT SELECT,INSERT ON TABLE public.collaboration_graph_events TO janus_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.collaboration_graphs,public.collaboration_graph_nodes,public.collaboration_graph_edges,public.collaboration_graph_events TO janus_migrator;
