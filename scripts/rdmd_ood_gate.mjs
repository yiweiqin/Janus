/**
 * OOD / 对抗探针的**基线门**：一条命令，可复跑，能红。
 *
 * 为什么要有它
 * ------------
 * `data/ood_summary.json` 与 `data/adv_summary.json` 是 V3 报告 §12–13 那些结论的唯一落脚点，
 * 而在此之前它们只被**手工命令**写过一次 —— `score_ood.py` 甚至不在任何 npm 脚本里，
 * 也没有任何东西核对过它们。改一行 `NODE_FIELDS` 或 `CAUSE_FIELDS` 就能让那张表变样，
 * 而报告里的数字照旧。第一次把门接起来就红了 23 + 20 处（见 PLAN_EXEC_TRUTH §14）。
 *
 * 为什么可以不带 GPU
 * ------------------
 * 门比的是**基线列**（rules A–E，纯函数），不是模型的列。模型列需要那份权重与一台 GPU，
 * 放进本地的门只会让门被跳过或被伪造。基线只要语料一样，计数就必须逐位一样。
 *
 * 为什么干净 clone 也能跑
 * ----------------------
 * 语料（`data/*_cases.jsonl`、`sft/ood.jsonl`、`sft/adversarial.jsonl`）不进版本库（体积），
 * 但它们是**种子确定性**的，重新生成与原地那份**逐字节相同**（已实测）。
 * 所以这一步就是"先造语料，再比计数"，而不是"语料不在就跳过"。
 *
 * ⚠️ 一个副作用要知道：重造语料会覆盖受版本控制的 `data/{ood,adv}_labels.json`。
 * 因为重建是逐字节相同的，正常情况 `git status` 不会变。**一旦变了，那就是探针定义变了**
 * —— 而门接着会因为参考里的语料哈希对不上而失败，这正是想要的信号。
 *
 * 用法：
 *   node scripts/rdmd_ood_gate.mjs                 # 造语料 + 过门
 *   node scripts/rdmd_ood_gate.mjs --no-regen      # 用现有语料过门
 *   node scripts/rdmd_ood_gate.mjs --selfcheck     # 门的负对照（证明它会红）
 *
 * 退出码：0 全过；1 有门没过；3 有未测到（缺语料等）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATASET = join(ROOT, 'experiments', 'rdmd_detective_dataset');

// 两个探针共用同一个 `score_ood.py`（门槛 A–E 只该有一份实现），只是输入不同。
const PROBES = [
  {
    name: 'ood',
    make: 'make_ood.mjs',
    labels: join(DATASET, 'data', 'ood_labels.json'),
    cases: join(DATASET, 'data', 'ood_cases.jsonl'),
    sft: join(DATASET, 'sft', 'ood.jsonl'),
    reference: join(DATASET, 'data', 'ood_baseline.json'),
  },
  {
    name: 'adv',
    make: 'make_adversarial.mjs',
    labels: join(DATASET, 'data', 'adv_labels.json'),
    cases: join(DATASET, 'data', 'adv_cases.jsonl'),
    sft: join(DATASET, 'sft', 'adversarial.jsonl'),
    reference: join(DATASET, 'data', 'adv_baseline.json'),
  },
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (result.error) {
    console.error(`[ood-gate] 起不来 ${command}: ${result.error.message}`);
    return 3;
  }
  return result.status ?? 3;
}

function main() {
  const argv = process.argv.slice(2);
  const noRegen = argv.includes('--no-regen');
  const selfcheck = argv.includes('--selfcheck');
  const python = process.env.RDMD_PYTHON || 'python';
  const node = process.execPath;

  const results = [];
  for (const probe of PROBES) {
    console.log(`\n${'='.repeat(72)}\n[ood-gate] 探针 ${probe.name}${selfcheck ? '（负对照）' : ''}\n${'='.repeat(72)}`);

    if (!noRegen) {
      // 这一步是"可复跑"的全部秘密：语料是派生物，不提交，但必须能被造出来。
      console.log(`[ood-gate] 造语料: node ${probe.make}`);
      const code = run(node, [join(DATASET, probe.make)]);
      if (code !== 0) {
        results.push({ probe: probe.name, stage: 'make', code });
        continue;
      }
    }

    const missing = [probe.labels, probe.cases, probe.sft].filter((path) => !existsSync(path));
    if (missing.length) {
      console.warn(`[ood-gate] 语料不全，${probe.name} 未测到:`);
      for (const path of missing) console.warn(`  缺 ${path}`);
      results.push({ probe: probe.name, stage: 'corpus', code: 3 });
      continue;
    }

    const args = [
      join(DATASET, 'score_ood.py'), '--gate', '--probe', probe.name,
      '--labels', probe.labels, '--cases', probe.cases, '--sft', probe.sft,
      '--reference', probe.reference,
    ];
    if (selfcheck) args.push('--selfcheck');
    const code = run(python, args);
    results.push({ probe: probe.name, stage: selfcheck ? 'selfcheck' : 'gate', code });
  }

  console.log(`\n${'='.repeat(72)}\n[ood-gate] 汇总\n${'='.repeat(72)}`);
  for (const row of results) {
    const mark = row.code === 0 ? 'PASS' : row.code === 3 ? '未测到' : 'FAIL';
    console.log(`  ${row.probe.padEnd(5)} ${row.stage.padEnd(10)} ${mark}`);
    // 参考文件是门的判据本身。把它的大小报出来，让人一眼看出"文件被换过"这类事故。
    const probe = PROBES.find((item) => item.name === row.probe);
    if (existsSync(probe.reference)) {
      console.log(`       参考 ${probe.reference} ${statSync(probe.reference).size} bytes`);
    }
  }

  if (results.some((row) => row.code === 3)) return 3;
  if (results.some((row) => row.code !== 0)) return 1;
  console.log('\n[ood-gate] 全部通过');
  return 0;
}

process.exit(main());
