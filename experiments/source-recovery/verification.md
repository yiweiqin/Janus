# Janus `src` 恢复验证

- 来源：`C:\Users\zhang\Desktop\src`
- 目标：`D:\Cli-anything\Janus\src`
- 源文件数：500
- 目标文件数：500
- 缺失文件：0
- 额外文件：0
- SHA-256 不一致：0

## 兼容性结果

- Cloud/Network 对 `src/shared` 共 61 次导入、21 个唯一目标文件，全部存在。
- `src/shared/evolution/index.js` 可加载，导出 93 个符号。
- `src/shared/contracts/uBuddyCapabilityProfile.js` 可加载，导出 10 个符号。
- Cloud 协作/API 测试：28/28 通过。
- uBuddy 实验 CLI 测试：4/4 通过。
- 协作状态图研究测试：1/1 通过。
- Evolution 测试：Node 22.23.2 下 42/42 通过。

## 额外修复

状态图原先只用 `created_at` 判断提交是否被后续修订覆盖。在 pg-mem 同一时间戳下会漏标 `superseded`。现在优先比较不可变的 `revision_no`，时间仅作为旧数据回退。

## 剩余阻塞

- 本机没有 Docker 或 `psql`。
- 未配置 `DATABASE_URL` / `EVOLUTION_WORKER_DATABASE_URL`。
- 因此尚未执行真实 PostgreSQL 持久化、Cloud Evolution Worker 和真实 Skill/Memory 进化闭环。
