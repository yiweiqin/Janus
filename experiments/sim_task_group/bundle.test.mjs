// 远程 bundle 的自足性测试。
//
// 这一条防的是一类**只会在盒子上现形**的失败：本地一切正常，上传后
// `ERR_MODULE_NOT_FOUND`（漏了一个 import）或 `ENOENT`（漏了一个数据文件，
// 比如 `loadPrompt` 读的 `prompts/*.txt` —— 它没有任何 import 指向）。
//
// 所以这里不只是"算一遍清单"，而是**真的在 stage 目录里起一个子进程把冒烟路径跑完**。
// 漏文件的症状就是那个子进程失败，别无其他。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_DIRS, DATA_FILES, ENTRIES, JANUS_ROOT, RUNTIME_FILES, closure, stage } from '../../scripts/_sim_stage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('the import closure has no dangling relative import', () => {
  const { files, missing } = closure();
  assert.deepEqual(missing, [], `有相对 import 指不到文件：${JSON.stringify(missing)}`);
  assert.ok(files.length > 20, `闭包只有 ${files.length} 个文件，太小了，多半是走错了`);
  // 入口自己必须在里面，否则说明闭包没从 ENTRIES 出发。
  for (const entry of ENTRIES) {
    assert.ok(files.some((file) => file.endsWith(entry.split('/').pop())), `入口 ${entry} 不在闭包里`);
  }
});

test('the imports a hand-written list would have missed are actually in the closure', () => {
  // 这几个是走闭包才捞到的：手写清单按 `sim_task_group` 的直接依赖写，
  // 会漏掉它们（`privacy.mjs` 依赖 `db.mjs`/`security.mjs`，`collect.mjs` 依赖契约）。
  const { files } = closure();
  const rel = files.map((file) => file.replace(/\\/g, '/').split('/Janus/').pop());
  for (const expected of [
    'cloud/src/db.mjs',
    'cloud/src/security.mjs',
    'src/shared/contracts/uBuddyReverseDetective.js',
    'cloud/src/modules/rdmd/privacy.mjs',
  ]) {
    assert.ok(rel.includes(expected), `闭包里少了 ${expected}`);
  }
});

test('the runtime-only data dependencies exist, including the one no import points to', () => {
  // `prompts/` 是最有代表性的一例：`llmClient.loadPrompt()` 用 join 读，
  // **没有 import**。所以它只能靠显式清单，而显式清单必须被断言守住。
  const promptDir = join(JANUS_ROOT, 'experiments/rdmd_detective_dataset/prompts');
  assert.ok(DATA_DIRS.some((dir) => dir.includes('rdmd_detective_dataset/prompts')));
  assert.ok(existsSync(join(promptDir, 'propagate_system.txt')), 'propagate_system.txt 不在（LLM 模式会 ENOENT）');
  for (const item of [...DATA_FILES, ...DATA_DIRS]) {
    assert.ok(existsSync(resolve(JANUS_ROOT, item)), `清单里的 ${item} 不存在 —— 清单过期了`);
  }
});

test('the bare packages the closure needs are declared, so the runner can preflight them', () => {
  // `cloud/src/db.mjs` 一上来就 `import pg from 'pg'`。它不在 bundle 里 ——
  // 必须由运行环境（盒子上的 node_modules）提供。第一版闭包只走相对 import，
  // 于是这个依赖是**隐形的**，症状是跑到一半 `ERR_MODULE_NOT_FOUND: Cannot find package 'pg'`。
  const { bareImports } = closure();
  assert.ok(bareImports.includes('pg'), `裸包清单里没有 pg：${JSON.stringify(bareImports)}`);
  // `node:` 内建不该被算进来。
  assert.ok(!bareImports.some((name) => name.startsWith('node:')), `内建模块混进来了：${JSON.stringify(bareImports)}`);
  // **每一条都必须是像包名的东西**。这一条防的是"正则把非 import 的东西也读成 import"：
  // `Object.freeze(['id', 'from', 'to'])` 里的 `'from'` 曾经让清单里多出一个 `, `
  // （见 `_sim_stage.mjs` 的 IMPORT_RE 注释）。那种脏条目不会让 stage 失败、也不会让
  // 冒烟测试失败，只会让"先按清单预检裸包"的 runner 去 `import(', ')`。
  for (const name of bareImports) {
    assert.match(name, /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i,
      `裸包清单里有不像包名的条目：${JSON.stringify(name)}`);
  }
});

test('the files the closure cannot see are declared, and they land in the stage', () => {
  // 闭包只看得见 import。`run_remote.sh` 是 shell 脚本、`briefs.jsonl` 是 pin 住的题面，
  // 两者在 import 图里都不存在。少了 run_remote.sh 的症状实测过：stage 成功、上传成功、
  // 解压成功，然后 `bash: run_remote.sh: No such file or directory`（退出码 127）。
  assert.ok(RUNTIME_FILES.includes('experiments/sim_task_group/run_remote.sh'));
  assert.ok(RUNTIME_FILES.includes('experiments/sim_task_group/briefs.jsonl'));
  for (const item of RUNTIME_FILES) {
    assert.ok(existsSync(resolve(JANUS_ROOT, item)), `清单里的 ${item} 不存在 —— 清单过期了`);
  }
  // 只断言"清单里有"不够：还得断言**它真的被复制进 stage 了**（走的是同一条数据文件路径）。
  const out = mkdtempSync(join(tmpdir(), 'sim-bundle-runtime-'));
  try {
    const { manifest } = stage({ out });
    for (const item of RUNTIME_FILES) {
      assert.ok(existsSync(join(out, item)), `${item} 没进 stage —— 盒子上会因为找不到它而 127`);
      assert.ok(manifest.some((row) => row.path === item), `${item} 不在 manifest 里，上传前校验就漏了它`);
    }
    // runner 要能被执行；`tar` 不保留 x 位，所以它在盒子上是靠 `bash run_remote.sh` 调的，
    // 这里只确认它像个 shell 脚本（有 shebang），而不是某个二进制。
    const first = readFileSync(join(out, 'experiments/sim_task_group/run_remote.sh'), 'utf8').split('\n')[0];
    assert.match(first, /^#!.*\bbash\b/, `run_remote.sh 第一行不像 shebang：${JSON.stringify(first)}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the staged bundle is self-sufficient: a child process can run the smoke path in it', () => {
  const out = mkdtempSync(join(tmpdir(), 'sim-bundle-'));
  try {
    const { manifest, bareImports } = stage({ out });
    assert.ok(manifest.length >= 30, `只有 ${manifest.length} 个文件`);
    // manifest 是上传前后校验的凭据，路径和摘要都得在。
    for (const item of manifest) {
      assert.ok(item.path && item.sha256?.length === 64 && item.bytes > 0, `manifest 行不完整：${JSON.stringify(item)}`);
      assert.ok(existsSync(join(out, item.path)), `manifest 说有 ${item.path}，实际没有`);
    }
    // 盒子上的做法：bundle 不带 node_modules，而是把运行环境的那个挂进来。
    // 这里用 junction 复刻同一件事，否则这条测试测的不是盒子的条件。
    assert.ok(bareImports.length > 0, '裸包清单是空的 —— 那下面的 junction 就成了摆设');
    symlinkSync(join(JANUS_ROOT, 'node_modules'), join(out, 'node_modules'), 'junction');
    // **真的在 stage 里跑**。这一条是全部意义所在：漏一个文件，这里就红。
    const script = `
      const proto = await import('./experiments/sim_task_group/lib/protocol.mjs');
      const sim = await import('./experiments/sim_task_group/simulate.mjs');
      const sub = await import('./experiments/sim_task_group/submit.mjs');
      const col = await import('./experiments/sim_task_group/collect.mjs');
      const store = await import('./experiments/sim_task_group/store.mjs');
      const briefs = proto.buildBriefs({ orgIds: ['org_01_consumer'], personLimitPerOrg: 2 });
      const result = await sim.generate({ briefs, mode: 'offline' });
      const built = sub.planBatches({ cases: result.cases, briefs });
      const report = col.summarize({
        rows: [], baseline: result.cases.map((c) => col.baselineCase(c)),
        shadow: result.cases.map((c) => col.shadowFor(c)),
        diagnostics: result.cases.map((c) => col.baselineDiagnostics(c)),
        expected: 0,
      });
      console.log(JSON.stringify({
        cases: result.cases.length, batches: built.batches.length,
        problems: built.problems.length, baseline: report.baseline.nodeTop1Rate,
        diag: report.baselineDiagnostics.ruleHitWithDecoys,
        edgeKind: typeof store.edgeKind,
      }));
    `;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: out, encoding: 'utf8', timeout: 10 * 60 * 1000,
    });
    const parsed = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(parsed.problems, 0, 'stage 里 planBatches 报错了');
    assert.ok(parsed.cases > 0, 'stage 里一个 case 都没生成');
    assert.equal(parsed.batches, parsed.cases, 'stage 里 brief join 掉了');
    assert.equal(parsed.edgeKind, 'function');
    // 基线数字在 stage 里应当与本地一致 —— 闭包漏了文件时这个值会变。
    assert.equal(parsed.baseline, 0, `stage 里基线变了：${parsed.baseline}`);
    assert.equal(parsed.diag, 0, `stage 里诊断变了：${parsed.diag}`);
  } finally {
    rmSync(join(out, 'node_modules'), { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('staging is byte-stable, so the same source always yields the same manifest', () => {
  const a = mkdtempSync(join(tmpdir(), 'sim-bundle-a-'));
  const b = mkdtempSync(join(tmpdir(), 'sim-bundle-b-'));
  try {
    const first = stage({ out: a });
    const second = stage({ out: b });
    assert.deepEqual(first.manifest, second.manifest, '两次 stage 的 manifest 不一致');
    // 也守住体积量级：全量仓库 3.6 GB，bundle 应该是 MB 级。
    const bytes = first.manifest.reduce((sum, item) => sum + item.bytes, 0);
    assert.ok(bytes < 40 * 1024 * 1024, `bundle 有 ${(bytes / 1024 / 1024).toFixed(1)} MB，太大了`);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('a missing data file fails the stage loudly instead of shipping a smaller roster', () => {
  // 负对照：把清单指向一个不存在的文件，stage 必须抛错。
  // 少了 agents.jsonl 的症状只是"角色库变小、brief 变少"，报告照出 —— 最难发现的那种。
  const out = mkdtempSync(join(tmpdir(), 'sim-bundle-neg-'));
  try {
    assert.throws(
      () => stage({ out, root: join(out, 'does-not-exist') }),
      /sim_bundle|ENOENT/i,
      '根目录不存在却 stage 成功了',
    );
    assert.ok(!existsSync(join(out, 'SIM_BUNDLE.json')), '失败时不该留下 manifest');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the bundle keeps the repo-relative layout that the sim imports assume', () => {
  // `sim_task_group` 用 `../../rdmd_detective_dataset/...` 这种相对路径 import，
  // 所以 stage 里必须还是 `<stage>/experiments/...`、`<stage>/src/...`。
  const out = mkdtempSync(join(tmpdir(), 'sim-bundle-layout-'));
  try {
    stage({ out });
    for (const item of [
      'experiments/sim_task_group/simulate.mjs',
      'experiments/rdmd_detective_dataset/lib/graph.mjs',
      'src/shared/contracts/uBuddyReverseDetective.js',
      'cloud/src/modules/rdmd/privacy.mjs',
      'package.json',
    ]) {
      const abs = join(out, item);
      assert.ok(existsSync(abs), `布局被破坏了：${item} 不在 stage 里`);
      assert.ok(statSync(abs).isFile());
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the stage script is wired to the same entries the runner uses', () => {
  // 入口清单和这里断言的四条命令是同一份，避免"runner 跑的是 A、bundle 装的是 B"。
  assert.deepEqual(ENTRIES.map((entry) => entry.split('/').pop()).sort(),
    ['collect.mjs', 'simulate.mjs', 'submit.mjs', 'tpm.mjs']);
  assert.ok(existsSync(join(HERE, 'collect.mjs')));
  // TPM 那条链的入口也要真在（它在 run_remote.sh 的第 6.5 步被调用）。
  assert.ok(existsSync(join(HERE, 'tpm.mjs')));
});
