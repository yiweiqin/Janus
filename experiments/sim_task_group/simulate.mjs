/**
 * 模拟任务群生成器：brief → 一批 case（`G_star` / `G_prime` / gold）。
 *
 * ## 两种模式，差别只在**文案来源**
 *
 * - `--mode offline`（默认）：零模型调用。骨架用内建默认句，注入/传播/诱饵走
 *   `rdmd_detective_dataset` 的原件。**盒子上默认就是这个** —— 盒子的实测结论是
 *   环境里没有任何模型密钥。
 * - `--mode llm`：模型写任务标题与步骤名（`sim_plan`），并写下游后果
 *   （`sim_propagate`，用语料自己的 `propagate_system.txt`）。密钥只在运行时经 env 注入。
 *
 * 两种模式的**图与 gold 完全同构、闸门完全同一条** —— 因为骨架形状、注入点、
 * 传播、诱饵、混淆、闸门全在 `lib/scenario.mjs` 里钉死，而它调的是语料的原件。
 * 模型只贡献字符串。这是刻意的：把形状交给模型，它会稳定地违反 `hop≥3`、
 * step 层字段白名单这类硬规则，而且违反之后不报错，只是样本变简单 ——
 * 那种失败在报告里长得跟"模型没学会"一模一样。
 *
 * ## 没有密钥时不许装作跑过
 *
 * `--mode llm` 在缺凭证时**直接抛**，不产出空文件。一个空的 `generated.jsonl`
 * 被后续步骤读成"0 条可提交"，跟"跑失败了"无法区分。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBriefs, planCases, SIM_SCHEMA } from './lib/protocol.mjs';
import { assembleCase, skeletonBudget } from './lib/scenario.mjs';
import { assertKeyNotPersisted, doctor, memoryCache, modelCredentials, simJson, simModel } from './lib/llm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BRIEFS = resolve(HERE, 'briefs.jsonl');
export const DEFAULT_OUT = resolve(HERE, 'out');

/** 确定性种子：同一个 case 永远拿到同一个种子，重跑逐字一致。 */
export function seedOf(text) {
  const digest = createHash('sha256').update(String(text)).digest();
  return digest.readUInt32BE(0) % 2147483647 || 1;
}

export function readBriefs(path = DEFAULT_BRIEFS, { limit = 0, personLimitPerOrg = 0 } = {}) {
  let briefs;
  if (existsSync(path)) {
    briefs = readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`briefs.jsonl 第 ${index + 1} 行不是合法 JSON：${error.message}`);
        }
      });
    if (!briefs.length) throw new Error(`briefs_missing_or_empty:${path}`);
  } else {
    // 没有落盘的 briefs 就现推 —— 推导是纯函数，不需要磁盘。
    briefs = buildBriefs(personLimitPerOrg ? { personLimitPerOrg } : {});
  }
  return limit > 0 ? briefs.slice(0, limit) : briefs;
}

// ---------------------------------------------------------------------------
// LLM 文案
// ---------------------------------------------------------------------------

const LLM_SYSTEM = [
  '你是 uBuddy 多智能体协作的模拟器。',
  '你只负责**写句子**：任务标题、步骤名。',
  '图的形状、谁是漂移源、改了哪个字段、下游第几跳起出现后果，都由调用方钉死，你无权改动。',
  '只输出 JSON 对象，不要任何解释或 markdown 围栏。',
].join('\n');

export function buildLlmPrompt(brief) {
  const budget = skeletonBudget(brief.participants.length);
  const roster = brief.participants.slice(0, budget.participants).map((participant, index) => ({
    index,
    agentId: participant.agentId,
    name: participant.name,
    family: participant.familyTitle,
    facet: participant.facetName,
    produces: participant.produces,
    consumes: participant.consumes,
  }));
  return JSON.stringify({
    task: '为一次跨职能协作写文案',
    topic: brief.topic,
    domain: brief.domain,
    organization: brief.orgName,
    department: brief.departmentName,
    lead: { title: brief.lead.title, owner: brief.lead.ownerDisplayName },
    roster,
    outputSchema: {
      tasks: {
        '<agentId>（必须是 roster 里的 agentId，一个都不能少、不能多）': {
          title: 'string，该参与者负责的任务标题',
          stage: 'string，两到四个字，如「调研」「建模」「交付」',
          inputs: 'string，来自上游参与者的哪些产出',
          artifact: 'string，产物名',
          output: 'string，一句话说明产出',
          summary: 'string，一两句话说明这一步怎么做',
          steps: `string[]，**至少 ${budget.stepsPerTask} 条**，每条不超过 20 字，按先后顺序`,
        },
      },
    },
  }, null, 2);
}

/**
 * 校验模型产出的文案。
 *
 * **只判文案是否可用，不判图**：图中的形状由装配器保证。这里查的是
 * "agentId 对不对得上""steps 够不够长"这类会让装配器退化的问题。
 */
export function validateLlmScript(value, brief) {
  const errors = [];
  const budget = skeletonBudget(brief.participants.length);
  const tasks = value?.tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    return { ok: false, errors: ['tasks_missing'] };
  }
  const known = new Set(brief.participants.slice(0, budget.participants).map((participant) => participant.agentId));
  for (const agentId of Object.keys(tasks)) {
    if (!known.has(agentId)) errors.push(`unknown_agent_id:${agentId}`);
  }
  for (const agentId of known) {
    const entry = tasks[agentId];
    if (!entry || typeof entry !== 'object') { errors.push(`task_missing:${agentId}`); continue; }
    // 少于预算条数不是"文案不好看"：step 链太短会让 step 层**一条 case 都注入不进去**
    // （见 scenario.mjs 的 `skeletonBudget` 推导），而症状只是"这几条没生成"。
    if (!Array.isArray(entry.steps) || entry.steps.length < budget.stepsPerTask) {
      errors.push(`steps_too_few:${agentId}=${Array.isArray(entry.steps) ? entry.steps.length : 0}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

async function scriptForBrief(brief, { mode, cache }) {
  if (mode !== 'llm') return { plan: {}, model: '', cached: false };
  const result = await simJson({ system: LLM_SYSTEM, user: buildLlmPrompt(brief), stage: 'sim_plan', cache });
  const check = validateLlmScript(result.value, brief);
  if (!check.ok) throw new Error(`sim_llm_script_invalid:${check.errors.join('|')}`);
  return { plan: result.value.tasks, model: result.model, cached: result.cached };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 生成全部 case。返回 `{cases, dropped, report}` —— **不写盘**，写盘在 `run` 里，
 * 这样测试可以直接在内存里断言。
 */
export async function generate({ briefs, mode = 'offline', cache = null } = {}) {
  const cases = [];
  const dropped = [];
  const byKind = {};
  const bySplit = {};
  const byVisibility = {};
  const hopHistogram = {};
  const gateErrors = {};
  const extraErrors = {};
  const dropReasons = {};
  const decoyCounts = {};
  const models = new Set();
  let llmFallbacks = 0;
  let cacheHits = 0;
  let participantsDropped = 0;

  const bump = (bucket, key) => { bucket[key] = (bucket[key] || 0) + 1; };
  const hopByTier = {};

  for (const brief of briefs) {
    participantsDropped += skeletonBudget(brief.participants.length).droppedParticipants;
    const script = await scriptForBrief(brief, { mode, cache });
    if (script.cached) cacheHits += 1;
    if (script.model) models.add(script.model);

    const plans = planCases(brief);
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      const seed = seedOf(plan.caseId);
      const assembled = await assembleCase({
        brief, plan, script: script.plan, seed, propagate: mode === 'llm' ? 'llm' : 'local', cache, index,
      });
      if (assembled.notes?.llmFallbacks) llmFallbacks += assembled.notes.llmFallbacks;
      if (!assembled.sample) {
        // 装配不出来是**预期的**失败（step 链太短、该层没有可用形态），
        // 但要计数、要带原因 —— 不能被当成"本来就没有这条"。
        dropped.push({ caseId: plan.caseId, reason: assembled.reason });
        bump(dropReasons, assembled.reason);
        continue;
      }
      if (assembled.errors.length) {
        dropped.push({ caseId: plan.caseId, reason: 'gate_failed', errors: assembled.errors });
        for (const error of assembled.errors) bump(gateErrors, String(error).split(':')[0]);
        continue;
      }
      if (assembled.extraErrors.length) {
        dropped.push({ caseId: plan.caseId, reason: 'step_tier_violation', errors: assembled.extraErrors });
        for (const error of assembled.extraErrors) bump(extraErrors, String(error).split(':')[0]);
        continue;
      }
      const sample = assembled.sample;
      sample.plan = {
        caseId: plan.caseId, kind: plan.kind, shape: plan.shape, tier: plan.tier,
        structural: Boolean(plan.structural), viaCpdbSimilarity: Boolean(plan.viaCpdbSimilarity),
        targetAgentId: plan.targetAgentId, targetTaskAgentId: plan.targetTaskAgentId,
        upstreamAgentId: plan.upstreamAgentId, substituteAgentId: plan.substituteAgentId,
      };
      sample.brief_id = brief.id;
      sample.org_id = brief.orgId;
      cases.push(sample);
      bump(byKind, plan.kind);
      bump(bySplit, sample.split);
      bump(byVisibility, sample.visibility);
      bump(decoyCounts, String((sample.label.decoy_nodes || []).length));
      const hopKey = sample.label.status === 'drift'
        ? String(sample.label.hop_to_first_effect)
        : sample.label.status;
      bump(hopHistogram, hopKey);
      // 按层拆开看 hop：step 层恒为 3 是**结构性**的（5 步链上只有一个点同时满足
      // "有前驱步骤"和"≥3 跳后代"），不是采样偶然。混在一起看会被平均值盖掉。
      if (sample.label.status === 'drift') {
        const tier = plan.tier || 'unknown';
        hopByTier[tier] = hopByTier[tier] || {};
        bump(hopByTier[tier], String(sample.label.hop_to_first_effect));
      }
    }
  }

  const report = {
    schema: `${SIM_SCHEMA}/generate-report`,
    mode,
    model: [...models].join(','),
    model_key_present: modelCredentials().configured,
    briefs: briefs.length,
    cases: cases.length,
    dropped: dropped.length,
    dropReasons,
    droppedDetail: dropped.slice(0, 200),
    byKind,
    bySplit,
    byVisibility,
    hopHistogram,
    hopByTier,
    decoyCounts,
    gateErrors,
    stepTierViolations: extraErrors,
    llmFallbacks,
    cacheHits,
    participantsDropped,
    // 报告里**不许**出现密钥，这条在写盘前还会再断言一次。
    no_drift_share: byKind.no_drift ? byKind.no_drift / Math.max(1, cases.length) : 0,
    subtle_share: byVisibility.subtle ? byVisibility.subtle / Math.max(1, cases.length) : 0,
  };
  return { cases, dropped, report };
}

function jsonl(rows) {
  return rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
}

/** 落盘 + 写盘前的密钥断言。**每一份产物都过一遍。** */
export function writeArtifacts(outDir, { cases, report, briefs }) {
  mkdirSync(outDir, { recursive: true });
  const generated = jsonl(cases);
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const briefsText = briefs ? jsonl(briefs) : '';
  assertKeyNotPersisted(generated, 'generated.jsonl');
  assertKeyNotPersisted(reportText, 'report.json');
  assertKeyNotPersisted(briefsText, 'briefs.jsonl');
  const files = {
    generated: resolve(outDir, 'generated.jsonl'),
    report: resolve(outDir, 'report.json'),
    briefs: resolve(outDir, 'briefs.jsonl'),
  };
  writeFileSync(files.generated, generated, 'utf8');
  writeFileSync(files.report, reportText, 'utf8');
  if (briefsText) writeFileSync(files.briefs, briefsText, 'utf8');
  return files;
}

export async function run({
  briefsPath = DEFAULT_BRIEFS, outDir = DEFAULT_OUT, mode = 'offline',
  limit = 0, personLimitPerOrg = 0, quiet = false, writeBriefs = true,
} = {}) {
  const info = doctor();
  if (mode === 'llm' && !info.configured) {
    throw new Error('model_endpoint_not_configured: --mode llm 需要 OPENAI_BASE_URL + CRS_OAI_KEY；盒子上请用 --mode offline');
  }
  const briefs = readBriefs(briefsPath, { limit, personLimitPerOrg });
  const cache = mode === 'llm' ? memoryCache() : null;
  const result = await generate({ briefs, mode, cache });
  const files = writeArtifacts(outDir, { ...result, briefs: writeBriefs ? briefs : null });
  if (!quiet) {
    console.log(`[sim-group] mode=${mode} briefs=${result.report.briefs} cases=${result.report.cases} dropped=${result.report.dropped}`);
    console.log(`[sim-group] kinds=${JSON.stringify(result.report.byKind)}`);
    console.log(`[sim-group] visibility=${JSON.stringify(result.report.byVisibility)} hop=${JSON.stringify(result.report.hopHistogram)}`);
    console.log(`[sim-group] decoys=${JSON.stringify(result.report.decoyCounts)}`);
    if (result.report.dropped) {
      console.log(`[sim-group] dropReasons=${JSON.stringify(result.report.dropReasons)}`);
      console.log(`[sim-group] gateErrors=${JSON.stringify(result.report.gateErrors)} stepTier=${JSON.stringify(result.report.stepTierViolations)}`);
    }
    if (result.report.llmFallbacks) console.log(`[sim-group] llmFallbacks=${result.report.llmFallbacks}`);
    console.log(`[sim-group] wrote ${files.generated}`);
  }
  return { ...result, files };
}

function parseArgs(argv) {
  const args = { mode: 'offline', briefsPath: DEFAULT_BRIEFS, outDir: DEFAULT_OUT, limit: 0, personLimitPerOrg: 0, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--mode') args.mode = argv[++i];
    else if (token === '--briefs') args.briefsPath = resolve(argv[++i]);
    else if (token === '--out') args.outDir = resolve(argv[++i]);
    else if (token === '--limit') args.limit = Number(argv[++i]) || 0;
    else if (token === '--people') args.personLimitPerOrg = Number(argv[++i]) || 0;
    else if (token === '--json') args.json = true;
    else if (token === '--doctor') args.doctor = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法: node experiments/sim_task_group/simulate.mjs [选项]
  --mode offline|llm   文案来源；offline 零模型调用（盒子上的默认）
  --briefs <path>      简报文件，缺省用内置推导
  --out <dir>          产物目录，缺省 experiments/sim_task_group/out
  --limit <n>          只跑前 n 个 brief
  --people <n>         每个组织取几个人（仅在内置推导时生效）
  --doctor             只打印模型配置的存在性（不回显密钥）
  --json               报告打到 stdout`);
    process.exit(0);
  }
  if (args.doctor) {
    console.log(JSON.stringify(doctor(), null, 2));
    process.exit(doctor().configured ? 0 : 1);
  }
  run(args)
    .then((result) => {
      if (args.json) console.log(JSON.stringify(result.report, null, 2));
      // 有 case 被丢掉就是**失败退出**：把它们悄悄跳过，报告会看起来像"这轮没跑满"。
      process.exit(result.report.dropped ? 1 : 0);
    })
    .catch((error) => {
      console.error(`[sim-group] 失败：${error.message}`);
      process.exit(1);
    });
}
