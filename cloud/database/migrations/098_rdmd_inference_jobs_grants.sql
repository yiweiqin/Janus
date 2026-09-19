-- requires-real-postgres: role grants reference roles that pg-mem fixtures do not have.
--
-- 为什么单独一条迁移，而不是把 GRANT 写进 097 的末尾就完事。
--
-- `applyMigrationFiles` 只按**文件名**记账（`schema_migrations.filename`），不校验内容哈希。
-- 所以对一条**已经应用过**的迁移，事后往文件里补语句是**完全无效**的 —— 它永远不会再跑一次。
-- 097 在一个环境上装过之后，那个环境就永远缺这几条授权，而且症状要到第一次真的入队才出现：
-- 迁移全绿、健康检查正常，只有 `POST /api/rdmd/jobs` 抛 `permission denied for table
-- cloud_rdmd_inference_jobs`（云 API 用 janus_api 连库，而表是 janus_migrator 建的）。
--
-- 因此：097 里那份是给**全新库**的（让建表与授权在同一个文件里读完即懂），
-- 本文件是给**已上过 097 的库**的补票。两份内容一致，GRANT 本身幂等，重复执行无副作用 ——
-- 这不是疏忽造成的重复，是"文件名记账"这个机制下唯一能修好存量环境的办法。
--
-- 单条手工补授权（没有迁移通道时用，例如只读运维窗口）：
--   GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_rdmd_inference_jobs TO janus_api;
--   GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.cloud_rdmd_inference_jobs TO janus_migrator;

GRANT SELECT,INSERT,UPDATE ON TABLE public.cloud_rdmd_inference_jobs TO janus_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.cloud_rdmd_inference_jobs TO janus_migrator;
