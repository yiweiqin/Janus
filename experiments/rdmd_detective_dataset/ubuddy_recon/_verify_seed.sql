-- Deliberately bimodal, partially-filled seed data.
--
-- Purpose: verify the analyzer reports DISTRIBUTIONS and never hides a bimodal shape behind a mean,
-- and that it separates the random baseline stratum from the top structural stratum. A seed that is
-- uniformly "rich" would pass every check and prove nothing, so this seed is built to be hostile:
--
--   tier A (g_1..g_20)    22 nodes, 12 events, public_summary filled everywhere
--   tier B (g_21..g_80)    6 nodes,  4 events, public_summary filled on ~2/3 of agent_task nodes
--   tier C (g_81..g_120)   2 nodes,  0 events, public_summary empty, no task_run link
--
-- So the honest readings are: node counts bimodal (2 / 6 / 22), summary fill rate partial, and a
-- third of graphs carry no events at all. If the analyzer ever prints a single mean here, or claims
-- a high fill rate, it is wrong and this seed will show it.

INSERT INTO collaboration_graphs
  (id, root_task_run_id, root_delegation_id, root_node_id, owner_user_id, title, current_revision, lifecycle_status)
SELECT
  'g_' || i,
  CASE WHEN i <= 80 THEN 'tr_' || i ELSE '' END,
  CASE WHEN i <= 80 THEN 'dl_' || i ELSE '' END,
  'root',
  'u_' || ((i % 7) + 1),
  'Task graph ' || i,
  CASE WHEN i <= 20 THEN 12 WHEN i <= 80 THEN 4 ELSE 0 END,
  'active'
FROM generate_series(1, 120) AS i;

-- root + ubuddy spine: every graph has these two.
INSERT INTO collaboration_graph_nodes
  (graph_id, node_id, parent_node_id, kind, task_run_id, delegation_id, owner_user_id,
   title, public_summary, status, progress, depth, source_revision)
SELECT 'g_' || i, 'root', '', 'root',
       CASE WHEN i <= 80 THEN 'tr_' || i ELSE '' END,
       CASE WHEN i <= 80 THEN 'dl_' || i ELSE '' END,
       'u_' || ((i % 7) + 1),
       'Root task', CASE WHEN i <= 80 THEN 'Root summary for graph ' || i ELSE '' END,
       'running', 35, 0, 1
FROM generate_series(1, 120) AS i;

INSERT INTO collaboration_graph_nodes
  (graph_id, node_id, parent_node_id, kind, task_run_id, delegation_id, owner_user_id,
   title, public_summary, status, progress, depth, source_revision)
SELECT 'g_' || i, 'ub_1', 'root', 'ubuddy',
       CASE WHEN i <= 80 THEN 'tr_' || i ELSE '' END,
       CASE WHEN i <= 80 THEN 'dl_' || i ELSE '' END,
       'u_' || ((i % 7) + 1),
       'Coordinator', CASE WHEN i <= 80 THEN 'Coordinator summary for graph ' || i ELSE '' END,
       'running', 35, 1, 1
FROM generate_series(1, 120) AS i;

-- agent_task leaves: 20 for tier A, 4 for tier B, none for tier C.
-- Tier B's every-3rd leaf gets an empty public_summary on purpose, so per-node and per-graph fill
-- rates differ and the analyzer cannot conflate them.
INSERT INTO collaboration_graph_nodes
  (graph_id, node_id, parent_node_id, kind, task_run_id, delegation_id, task_node_id, owner_user_id,
   owner_agent_id, owner_agent_instance_id, title, public_summary, status, progress, depth, source_revision)
SELECT
  'g_' || i,
  'at_' || j,
  'ub_1',
  'agent_task',
  'tr_' || i,
  'dl_' || i,
  'tn_' || i || '_' || j,
  'u_' || ((i % 7) + 1),
  'agent_' || j,
  'inst_' || i || '_' || j,
  'Step ' || j || ' of graph ' || i,
  CASE
    WHEN i <= 20 THEN 'Step ' || j || ' summary'
    WHEN i <= 80 AND (j % 3) <> 0 THEN 'Step ' || j || ' summary'
    ELSE ''
  END,
  CASE WHEN j % 4 = 0 THEN 'failed' WHEN j % 3 = 0 THEN 'blocked' ELSE 'completed' END,
  CASE WHEN j % 2 = 0 THEN 100 ELSE 35 END,
  2,
  1
FROM generate_series(1, 120) AS i
CROSS JOIN LATERAL generate_series(1, CASE WHEN i <= 20 THEN 20 WHEN i <= 80 THEN 4 ELSE 0 END) AS j;

-- Edges: parent_of spine, plus dependency_of between tier A leaves (the causal-cascade signal).
INSERT INTO collaboration_graph_edges (graph_id, edge_id, kind, from_node_id, to_node_id, source_revision)
SELECT 'g_' || i, 'e_root_ub', 'parent_of', 'root', 'ub_1', 1
FROM generate_series(1, 120) AS i;

INSERT INTO collaboration_graph_edges (graph_id, edge_id, kind, from_node_id, to_node_id, source_revision)
SELECT 'g_' || i, 'e_ub_at_' || j, 'parent_of', 'ub_1', 'at_' || j, 1
FROM generate_series(1, 120) AS i
CROSS JOIN LATERAL generate_series(1, CASE WHEN i <= 20 THEN 20 WHEN i <= 80 THEN 4 ELSE 0 END) AS j;

INSERT INTO collaboration_graph_edges (graph_id, edge_id, kind, from_node_id, to_node_id, source_revision)
SELECT 'g_' || i, 'e_dep_' || j, 'dependency_of', 'at_' || j, 'at_' || (j + 1), 1
FROM generate_series(1, 20) AS i
CROSS JOIN LATERAL generate_series(1, 19) AS j;

-- Events: the change stream. graph_revision increases 1..N, so a before/after pair is obtainable.
INSERT INTO collaboration_graph_events
  (graph_id, graph_revision, event_id, event_type, node_id, public_patch_json, actor_user_id,
   actor_agent_instance_id, created_at)
SELECT
  'g_' || i,
  r,
  'ev_' || i || '_' || r,
  (ARRAY['node_added','execution_started','progress_published','node_completed','result_submitted',
         'rework_requested','execution_failed','execution_retried','replan_requested','node_updated',
         'handoff_published','graph_updated'])[((r - 1) % 12) + 1],
  CASE WHEN r % 2 = 0 THEN 'at_1' ELSE 'ub_1' END,
  jsonb_build_object('status', CASE WHEN r % 4 = 0 THEN 'failed' ELSE 'running' END,
                     'progress', (r * 5) % 101,
                     'note', 'revision ' || r),
  'u_1',
  'inst_' || i || '_1',
  now() - ((12 - r) || ' minutes')::interval
FROM generate_series(1, 120) AS i
CROSS JOIN LATERAL generate_series(1, CASE WHEN i <= 20 THEN 12 WHEN i <= 80 THEN 4 ELSE 0 END) AS r;

-- Task runs / nodes for tier A+B only; tier C deliberately has no linkage.
INSERT INTO cloud_task_runs (id, owner_user_id, payload_json)
SELECT 'tr_' || i, 'u_' || ((i % 7) + 1), jsonb_build_object('status', 'completed', 'delegationId', 'dl_' || i)
FROM generate_series(1, 80) AS i;

INSERT INTO cloud_task_nodes (id, task_run_id, user_agent_instance_id, payload_json)
SELECT 'tn_' || i || '_' || j, 'tr_' || i, 'inst_' || i || '_' || j,
       jsonb_build_object('id', 'tn_' || i || '_' || j, 'task_run_id', 'tr_' || i,
                          'agent_instance_id', 'inst_' || i || '_' || j,
                          'status', CASE WHEN j % 4 = 0 THEN 'failed' ELSE 'accepted' END,
                          'estimated_minutes', 20)
FROM generate_series(1, 80) AS i
CROSS JOIN LATERAL generate_series(1, CASE WHEN i <= 20 THEN 20 ELSE 4 END) AS j;

-- Result versions: the rich-text layer. Tier A gets two nodes with a superseded->adopted pair;
-- tier B gets a single adopted row (so "has >= 2 revisions" is only partly true, which is the point).
INSERT INTO task_node_result_versions
  (id, task_run_id, task_node_id, graph_revision_id, version_no, result_text, result_summary,
   decision, decision_reason, created_at, decided_at)
SELECT 'rv_' || i || '_' || j || '_1', 'tr_' || i, 'tn_' || i || '_' || j, 'graph_1', 1,
       'Draft result ' || j || ' for graph ' || i,
       'Draft summary ' || j || ' for graph ' || i,
       'superseded', 'requirements revised', now() - interval '5 minutes', now() - interval '5 minutes'
FROM generate_series(1, 80) AS i
CROSS JOIN LATERAL generate_series(1, CASE WHEN i <= 20 THEN 2 ELSE 1 END) AS j;

INSERT INTO task_node_result_versions
  (id, task_run_id, task_node_id, graph_revision_id, version_no, result_text, result_summary,
   decision, decision_reason, created_at, decided_at)
SELECT 'rv_' || i || '_' || j || '_2', 'tr_' || i, 'tn_' || i || '_' || j, 'graph_2', 2,
       'Final result ' || j || ' for graph ' || i,
       'Final summary ' || j || ' for graph ' || i,
       'adopted', 'accepted', now(), now()
FROM generate_series(1, 80) AS i
CROSS JOIN LATERAL generate_series(1, CASE WHEN i <= 20 THEN 2 ELSE 1 END) AS j;
