/**
 * 编码卫生：源码/迁移/JSON **不许带 UTF-8 BOM**。
 *
 * 为什么值得一条测试：BOM 不是风格问题，它是**静默**故障源，而且踩过两次真坑。
 *
 *   1. `package.json` 带上 BOM 后，`cloud/src/server.mjs` 的
 *      `JSON.parse(readFileSync(package.json,'utf8'))` 抛 `Unexpected token ''`
 *      —— 整个云 API 起不来，而报错指向 package.json 的"语法错误"。
 *      同一个 BOM 还让 `readDesktopPackageVersion()` 的 catch 静默返回 `'0.0.0'`，
 *      于是云端一致性检查同时报 `app_version_too_old` + `required_migration_missing`，
 *      整条 Sync V6 被判成不兼容 —— 错误信息里完全看不出是编码问题。
 *   2. `.sql` 迁移带上 BOM 后，Postgres 对 `\uFEFF` 不当空白，直接报
 *      `syntax error at or near ""`，迁移装不上。
 *
 * 这两条都可以在代码里容错（`server.mjs`/`db.mjs` 现在都会剥 BOM，那是必须的防御），
 * 但容错只解决"已经发生"，不解决"会再发生"：只要写文件的工具偶尔加上 BOM，
 * 下一个人就会再花半天。所以再加一条把它变成**立刻可见的失败**。
 *
 * 扫描范围刻意限定在"会被当作文本读取/执行的东西"上，而不是全仓：
 *
 *   1. 云 API 启动路径：根 package.json、cloud/src、cloud/database（迁移）。
 *   2. GPU 盒部署 bundle：`scripts/**`、`cloud/test/**`、
 *      `experiments/rdmd_detective_dataset/deploy/**`。
 *      这一批**也是文本**：上传、比对 sha256、在盒子上的解释器里执行。
 *   3. 桌面端源码：`src/**`、`network/**` —— 它们由 Node 以 ESM 加载。
 *
 * **`.sh` 必须在范围内**，这是踩出来的：`_rdmd_worker_daemon.sh` 带 BOM 部署到盒子上后，
 * 每次调用都先吐 `#!/usr/bin/env: No such file or directory` —— 报错指向一个不存在的
 * 可执行文件，而真正的错是第 1 行比对的 3 个字节。更坏的是脚本**看起来还能用**
 * （因为是 `bash <file>` 调用的），所以很容易被当成无关噪声放过。
 *
 * 跳过 `archive/` 与语料/运行产物目录（sft、runs、adapters 等）：它们不是源码，
 * 扫它们既慢又不会带来信息。
 *
 * 运行：node --test cloud/test/encoding-hygiene.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLOUD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(CLOUD_ROOT, '..');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SKIP_DIRS = new Set([
  'node_modules', 'archive', '.git', 'dist', 'build', 'coverage',
  // 语料/权重/运行产物：不是源码，扫它们既慢又不会带来信息。
  'sft', 'runs', 'adapters', 'samples', 'generated',
]);
// `.sh` 也是文本、也会被执行 —— 见文件头那次 `#!/usr/bin/env: No such file or directory`。
const SOURCE_EXTS = ['.mjs', '.js', '.cjs', '.py', '.sh', '.sql', '.json'];

function walk(root, extensions) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(full);
    }
  }
  return found;
}

function hasBom(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(3);
    fs.readSync(handle, head, 0, 3, 0);
    return head.equals(BOM);
  } finally {
    fs.closeSync(handle);
  }
}

function assertNoBom(files, label) {
  const offenders = files.filter(hasBom).map((file) => path.relative(REPO_ROOT, file));
  assert.deepEqual(offenders, [],
    `${label} 里出现了带 UTF-8 BOM 的文件。BOM 会让 JSON.parse 直接抛异常`
    + `（云 API 起不来）、让 Postgres 报 'syntax error at or near "\uFEFF"'（迁移装不上）。`
    + `删掉文件开头那 3 个字节即可，不要靠下游容错兜着。`);
}

test('cloud sources and migrations carry no UTF-8 BOM', () => {
  const files = [
    ...walk(path.join(CLOUD_ROOT, 'src'), ['.mjs', '.js']),
    ...walk(path.join(CLOUD_ROOT, 'database'), ['.sql']),
  ];
  assert.ok(files.length > 50, `扫描到的文件太少（${files.length}），说明遍历逻辑坏了而不是没问题`);
  assertNoBom(files, 'cloud/src 与 cloud/database');
});

test('the root package.json carries no UTF-8 BOM', () => {
  // 单独钉一条：它是 `server.mjs` 启动路径上唯一被 JSON.parse 的文件，
  // 而"启动即崩"应该是这条测试先发现，而不是部署时先发现。
  const manifest = path.join(REPO_ROOT, 'package.json');
  assert.equal(hasBom(manifest), false, 'package.json 带 BOM 会让云 API 无法启动');
  // 顺带证明它真的可解析 —— 上面那条只说明"没有 BOM"，这条说明"能被读出来"。
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(typeof parsed.version, 'string');
  assert.ok(parsed.version.length > 0);
});

test('the GPU-box deployment bundle carries no UTF-8 BOM', () => {
  // 这批文件不经过云 API 的启动路径，但经过**同一条上传/执行**路径：
  // rdmd_gpu_worker.py 与 predict.py / rdmd_detective.py 在盒子上被 python 直接跑，
  // 而 worker 会读 `rdmd_detective.CONTRACT_VERSION` 与云侧下发的版本比对 ——
  // 一个 BOM 就足以让一次比对得出"契约不一致"，或者让哈希校验对着不同的字节较劲。
  // 部署脚本自己也有校验，但那时人已经在盒子上了；本地先失败便宜得多。
  const files = [
    ...walk(path.join(REPO_ROOT, 'scripts'), SOURCE_EXTS),
    ...walk(path.join(CLOUD_ROOT, 'test'), ['.mjs']),
    ...walk(path.join(REPO_ROOT, 'experiments', 'rdmd_detective_dataset', 'deploy'), ['.py', '.mjs']),
  ];
  assert.ok(files.length > 40, `扫描到的 bundle 文件太少（${files.length}），说明遍历逻辑坏了而不是没问题`);
  assertNoBom(files, 'GPU 盒部署 bundle（scripts/、cloud/test、deploy/）');
});

test('the desktop sources carry no UTF-8 BOM', () => {
  // 桌面端由 Node 以 ESM 加载：BOM 在 `import` 上直接是 SyntaxError（比云侧更容易发现，
  // 但发现得越早越便宜 —— 它不该等到某次打包或运行时才炸）。
  const files = [
    ...walk(path.join(REPO_ROOT, 'src'), ['.js', '.mjs']),
    ...walk(path.join(REPO_ROOT, 'network'), ['.js', '.mjs']),
  ];
  assert.ok(files.length > 100, `扫描到的桌面端文件太少（${files.length}）`);
  assertNoBom(files, 'src/ 与 network/');
});
