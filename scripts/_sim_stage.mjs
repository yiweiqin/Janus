// 把 sim_task_group 真正需要的文件**算出来**，而不是手写一张清单。
//
// 为什么不用手写清单：`sim_task_group` 从仓库的四个目录各 import 一点
// （`experiments/rdmd_detective_dataset/lib`、`src/shared/contracts`、`cloud/src/modules/rdmd`、
// `scripts`）。手写清单漏一个 import，盒子上的症状是 `ERR_MODULE_NOT_FOUND`，
// 而那要等到上传完、跑起来才现形 —— 每次修一个、再传一遍。
// 这里改成从入口出发走一次**相对 import 的传递闭包**，漏不掉。
//
// 另外：仓库本地 3.6 GB（`experiments` 2.4 GB 是权重和产物），全量上传不可行。
// 所以必须精确到文件。算出来的清单会连同 sha256 一起落成 manifest，
// 上传前后各校验一次 —— "传上去了"和"传对了"是两件事。
//
// 用法：
//   node scripts/_sim_stage.mjs --out <stageDir>            # 只算 + 复制 + 打 manifest
//   node scripts/_sim_stage.mjs --out <stageDir> --list      # 只打印清单

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const JANUS_ROOT = resolve(HERE, '..');

/** 入口：盒子要跑的四条命令各自的入口模块。 */
export const ENTRIES = [
  'experiments/sim_task_group/simulate.mjs',
  'experiments/sim_task_group/submit.mjs',
  'experiments/sim_task_group/collect.mjs',
  // TPM 那条链（申请→预审→终审→读）是第 5 条命令，跑在库上。
  // 它 import 了 `cloud/src/modules/tpm/index.mjs` 与
  // `src/shared/contracts/uBuddyTaskPublicMemory.js` —— 两个都在 cloud/ 与 src/ 里，
  // 所以闭包必须从**这个入口**出发才带得上它们（否则盒子上的症状是 ERR_MODULE_NOT_FOUND）。
  'experiments/sim_task_group/tpm.mjs',
];

/**
 * 非 import 的运行时依赖 —— 相对 import 闭包看不见它们，所以必须显式列出。
 * **这一份要随着 sim 读新文件而更新**，所以下面有断言：任何一项不存在就直接失败，
 * 不会"静默少传一个"。
 *
 * `prompts/` 是最有代表性的一例：`llmClient.loadPrompt()` 用
 * `join(ROOT, '../prompts', name)` 读文件，**没有任何 import 指向它**。
 * LLM 模式下缺了它，症状是"本地跑得好好的、盒子上 ENOENT"。
 */
export const DATA_DIRS = [
  // `loadPrompt('propagate_system.txt')` 从这儿读 —— 见上文。
  'experiments/rdmd_detective_dataset/prompts',
];

export const DATA_FILES = [
  // 角色库：600 个 specialist + 人。题面也来自这里。
  'experiments/cpdb_org_world/data/full/people.jsonl',
  'experiments/cpdb_org_world/data/full/agents.jsonl',
  'experiments/cpdb_org_world/data/full/orgs.jsonl',
  // 语料 schema（forms/gates/graph 都从它读 driftTypes 与 nodeKinds）。
  'experiments/rdmd_detective_dataset/schema.json',
  // package.json 决定 `"type": "module"` —— 少了它 node 会把这个目录当 CJS，直接炸。
  'package.json',
];

/**
 * 既不是 import 也不是"数据"的运行时依赖：**shell 脚本**。
 *
 * 闭包只看得见 import，`run_remote.sh` 在 import 图里完全不存在 —— 少了它，
 * 盒子上的症状是 `bash: run_remote.sh: No such file or directory`，退出码 127
 * （实测踩过：stage 成功、上传成功、解压成功，然后第一条命令就找不到文件）。
 * 它必须跟着 bundle 走：盒子上的 `/root/Janus` 是旧快照，本机改的 runner 版本
 * 才是要跑的那一版。
 *
 * `briefs.jsonl` 是"pin 住的题面"而不是数据：`simulate.mjs` 在没有它时会**重新推导**
 * 一份，而推导结果随角色库/`--limit` 变。带上它，盒子上跑的就是本机这份题面，
 * 报告才对得上。（`protocol.mjs --write` 生成它；`protocol.test.mjs` 守着它与函数推导一致。）
 */
export const RUNTIME_FILES = [
  'experiments/sim_task_group/run_remote.sh',
  'experiments/sim_task_group/briefs.jsonl',
];

// 只认真正的 import 形态。第一版写得太松（`import|export` + 任意非引号字符 + 引号），
// 于是 `export const SIM_ROOT = resolve(HERE, '..')` 被当成 import '..'、
// `join(ROOT, '../prompts', name)` 被当成 import '../prompts'，报 3 个假缺失。
//
// 每条第 1、2 款前面那个 `[^A-Za-z0-9_$'"]` 守卫也是必须的，理由同一类：
// `Object.freeze(['id', 'from', 'to', 'kind'])` 里 `'from'` 的**闭引号**后面紧跟着
// `, '`，没有守卫就会被读成一条 `from ', '` 的 import —— 裸包清单里于是多出一个
// `, `（实测在 `cloud/src/modules/rdmd/privacy.mjs:33` 与
// `src/shared/contracts/uBuddyPlanExec.js:47` 各踩到一次）。
// 真关键字前面一定是空白或 `}`/`;`/`)`，绝不会是引号。
const NOT_IDENT_OR_QUOTE = String.raw`[^A-Za-z0-9_$'"]`;
const IMPORT_RE = new RegExp([
  `(?:^|${NOT_IDENT_OR_QUOTE})from\\s*['"]([^'"]+)['"]`,                 // import x from '...' / export x from '...'
  `(?:^|${NOT_IDENT_OR_QUOTE})import\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)`, // 动态 import('...')
  String.raw`(?:^|\n)\s*import\s*['"]([^'"]+)['"]`,                      // 裸 import '...'
].join('|'), 'gm');

/** 相对 import 的目标。裸包名（`pg`、`node:fs`）跳过 —— 那些走盒子上的 node_modules。 */
function relativeTargets(source) {
  const found = new Set();
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] || match[2] || match[3];
    if (!spec || !spec.startsWith('.')) continue;
    found.add(spec);
  }
  return found;
}

/** 解析相对 spec 到一个真实文件。带扩展名的直接用；不带扩展名的按 ESM 规则只认确切文件名。 */
function resolveSpec(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, join(base, 'index.mjs'), join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * 裸包名（`pg`、`jsonwebtoken`…）—— 相对 import 闭包管不到它们，因为它们是
 * `node_modules` 里的事。但不该假装它们不存在：`cloud/src/db.mjs` 一上来就
 * `import pg from 'pg'`，而盒子上的 `node_modules` 在 `/root/Janus/node_modules`、
 * 不在 bundle 的 stage 根下。所以把清单算出来，让 runner **先校验再开跑** ——
 * 症状就从 `ERR_MODULE_NOT_FOUND`（跑到一半才炸）变成一句能照着做的报错。
 */
function bareTargets(source) {
  const found = new Set();
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] || match[2] || match[3];
    if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    // `@scope/name/sub` → `@scope/name`；`pg/lib/x` → `pg`
    const parts = spec.split('/');
    found.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  return found;
}

/** 传递闭包。返回绝对路径集合；缺失的相对 import 会被**报出来**而不是跳过。 */
export function closure(entries = ENTRIES, { root = JANUS_ROOT } = {}) {
  const seen = new Set();
  const bare = new Set();
  const missing = [];
  const queue = entries.map((entry) => resolve(root, entry));
  for (const entry of queue) {
    if (!existsSync(entry)) missing.push({ from: '(entry)', spec: relative(root, entry).split(sep).join('/') });
  }
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const name of bareTargets(source)) bare.add(name);
    for (const spec of relativeTargets(source)) {
      const target = resolveSpec(file, spec);
      if (!target) {
        // 不静默跳过：少一个文件在盒子上的症状是 ERR_MODULE_NOT_FOUND，
        // 而那时已经上传完了。在本地就炸掉，成本最低。
        missing.push({ from: relative(root, file).split(sep).join('/'), spec });
        continue;
      }
      if (!seen.has(target)) queue.push(target);
    }
  }
  return { files: [...seen].sort(), bareImports: [...bare].sort(), missing };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const rel = (path, root) => relative(root, path).split(sep).join('/');

/**
 * 复制出可运行的 stage 目录，并落 manifest。
 *
 * 关键点：**保持仓库相对布局**。`sim_task_group` 用 `../../rdmd_detective_dataset/...`
 * 这种相对路径 import，布局一变就全断。所以 stage 里仍是
 * `<stage>/experiments/sim_task_group/...`、`<stage>/src/shared/contracts/...`。
 */
export function stage({ out, root = JANUS_ROOT } = {}) {
  const { files, bareImports, missing } = closure(ENTRIES, { root });
  if (missing.length) {
    const lines = missing.map((item) => `  ${item.from} -> ${item.spec}`).join('\n');
    throw new Error(`sim_bundle_import_missing:\n${lines}`);
  }
  const dataMissing = DATA_FILES.filter((item) => !existsSync(resolve(root, item)));
  const dirsMissing = DATA_DIRS.filter((item) => {
    const abs = resolve(root, item);
    return !existsSync(abs) || !statSync(abs).isDirectory();
  });
  const scriptsMissing = RUNTIME_FILES.filter((item) => !existsSync(resolve(root, item)));
  if (dataMissing.length || dirsMissing.length || scriptsMissing.length) {
    // 数据文件也要 fail closed。少一个 jsonl 只会让角色库静默变小、brief 变少，
    // 报告照出 —— 那种失败最难发现。
    const lines = [...dataMissing, ...dirsMissing, ...scriptsMissing].map((item) => `  ${item}`).join('\n');
    throw new Error(`sim_bundle_data_missing:\n${lines}`);
  }
  rmSync(out, { recursive: true, force: true });
  const manifest = [];
  const dataFiles = [];
  for (const dir of DATA_DIRS) {
    // 目录整份带走（小文件，几十 KB）。比逐个列文件稳：加一个 prompt 不会漏。
    for (const name of readdirSync(resolve(root, dir))) {
      const abs = resolve(root, dir, name);
      if (statSync(abs).isFile()) dataFiles.push(rel(abs, root));
    }
  }
  for (const abs of [...files, ...[...DATA_FILES, ...dataFiles, ...RUNTIME_FILES].map((item) => resolve(root, item))]) {
    const target = join(out, rel(abs, root));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(abs, target);
    manifest.push({ path: rel(abs, root), bytes: statSync(abs).size, sha256: sha256(abs) });
  }
  manifest.sort((a, b) => (a.path < b.path ? -1 : 1));
  writeFileSync(join(out, 'SIM_BUNDLE.json'), `${JSON.stringify({
    schema: 'ubuddy_sim_task_group_v1/bundle',
    entries: ENTRIES,
    dataFiles: DATA_FILES,
    dataDirs: DATA_DIRS,
    runtimeFiles: RUNTIME_FILES,
    // 裸包名：stage 里不装 node_modules，这些必须由**运行环境**提供。
    // runner 会先校验它们能被解析，再开跑。
    bareImports,
    fileCount: manifest.length,
    totalBytes: manifest.reduce((sum, item) => sum + item.bytes, 0),
    files: manifest,
  }, null, 2)}\n`, 'utf8');
  return { out, manifest, files, bareImports };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? resolve(argv[outIndex + 1]) : resolve(JANUS_ROOT, 'experiments/sim_task_group/.bundle');
  try {
    if (argv.includes('--list')) {
      const { files, bareImports, missing } = closure();
      if (missing.length) throw new Error(`sim_bundle_import_missing:${JSON.stringify(missing)}`);
      process.stdout.write(`${files.map((file) => rel(file, JANUS_ROOT)).join('\n')}\n`);
      process.stdout.write(`# bare imports (需运行环境提供): ${bareImports.join(' ') || '(none)'}\n`);
    } else {
      const { manifest, bareImports } = stage({ out });
      process.stdout.write(`[sim-stage] ${manifest.length} 个文件，`
        + `${(manifest.reduce((sum, item) => sum + item.bytes, 0) / 1024).toFixed(0)} KB -> ${out}\n`);
      for (const item of manifest) process.stdout.write(`  ${String(item.bytes).padStart(8)}  ${item.path}\n`);
      process.stdout.write(`[sim-stage] 裸包（由运行环境的 node_modules 提供）：`
        + `${bareImports.join(' ') || '(none)'}\n`);
    }
  } catch (error) {
    process.stderr.write(`[sim-stage] ${error.message}\n`);
    process.exitCode = 1;
  }
}
