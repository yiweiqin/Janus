-- 放开 collaboration_graph_nodes.depth 的上界。
--
-- 背景：094 给 depth 加了 CHECK(depth BETWEEN 0 AND 2)，那是「三层骨架」时期的假设。
-- 四层图需要 agent_step 落在 depth 3：
--   root(0) -> ubuddy(1) -> agent_task(2) -> agent_step(3)
-- 上界不放开，agent 的执行规划就永远进不了图，`sequence_of` 链也就无从建立。
--
-- 桌面端不需要迁移：本地 SQLite 的 collaboration_graph_nodes.depth 只有
-- `depth INTEGER NOT NULL DEFAULT 0`（sqliteSchema.js / sqliteMigrations.js），没有 CHECK，
-- 一直只是 JS 侧在钳制。所以只有云侧需要动。
--
-- 云侧写入仍会被 collaborationGraph.mjs 的 boundedNodeDepth() 按 kind 钳制，
-- 这里只是去掉数据库这一层的硬上界。

-- 常规路径：Postgres 给列级匿名 CHECK 取的名字就是 <table>_<column>_check。
ALTER TABLE public.collaboration_graph_nodes
  DROP CONSTRAINT IF EXISTS collaboration_graph_nodes_depth_check;

-- requires-real-postgres-tail: pg-mem 没有 plpgsql，下面的兜底 DO 块会被 pg-mem 跳过。
-- 常规路径那条 DROP CONSTRAINT IF EXISTS 仍然会在 pg-mem 上执行，所以迁移账本照常推进。

-- 兜底：若历史上约束被取了别的名字，按定义找出来删掉。
-- 不能只依赖上面那条 —— 名字对不上时会静默什么都不做，留下一颗定时炸弹。
DO $$
DECLARE target text;
BEGIN
  FOR target IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'collaboration_graph_nodes'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid, true) ILIKE '%depth%'
  LOOP
    EXECUTE format('ALTER TABLE public.collaboration_graph_nodes DROP CONSTRAINT %I', target);
    RAISE NOTICE '[janus-cloud] dropped depth constraint %', target;
  END LOOP;
END $$;
