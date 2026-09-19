/**
 * 提交：把模拟出来的 case 送进盒子云 API 的 `/api/rdmd/jobs`。
 *
 * ## 凭据不抄第二份
 *
 * token 与 device grant 都来自 `scripts/rdmd_cloud_e2e.mjs` 的 `provision()`
 * （那里用**真 RSA 私钥 + 真签名 proof**，并把 `rdmd:infer` 签给在册的服务身份）。
 * 计划里写的是"直接抄"，但抄一份的代价是四件容易抄漏的事各漏一次：
 * RSA 指纹、proof 时间窗、nonce 入表、服务身份收口。少抄一件，这里会卡在 403，
 * 而症状看起来像"云侧不认我们的 worker"。
 *
 * ## 身份：**用合成 sim 用户，不给 CPDB 的人编云账号**
 *
 * CPDB 世界里的 `p_01_00` 这些人是**实验数据里的角色**，不是云库的 `users` 行。
 * 为了发作业而给他们插 users 行，等于往生产用户表里灌假账号 —— 事后没人分得清
 * 哪些是真用户。所以云侧一切身份统一用 `user_sim_task_group`，
 * 而"这个 case 来自哪个组织的哪个人"留在 `generated.jsonl` / `briefs.jsonl` 里
 * （case 的 `org_id` / `brief_id` / `plan.targetAgentId`）。
 * 这条边界不是洁癖：`users` 表被污染之后，「多少真实用户在用」这个数就永远不可信了。
 *
 * ## 悬空 case 与有根 case
 *
 * 只 POST 的话，云侧看到的是一条没有来源的 case。所以默认**先**把 `G_plan` 写进
 * `collaboration_graph_*`（`store.mjs`），再提交 —— 于是判定结果能回指到一个真实存在的
 * 协作图。`--skip-store` 保留下来只为一件事：对比"有根/无根"两种提交在报告里是否可区分。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPgPool } from '../../cloud/src/db.mjs';
import { signAccessToken } from '../../cloud/src/security.mjs';
import { auditRdmdCloudPayload, buildRdmdCloudPayload } from '../../cloud/src/modules/rdmd/privacy.mjs';
import { get, post, provision } from '../../scripts/rdmd_cloud_e2e.mjs';
import { graphRows, readGraphSummary, writeGraph } from './store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CASES = resolve(HERE, 'out/generated.jsonl');
export const DEFAULT_BRIEFS = resolve(HERE, 'out/briefs.jsonl');
export const DEFAULT_JOBS = resolve(HERE, 'out/jobs.jsonl');

/**
 * 云侧统一身份。见文件头：**刻意不**给 CPDB 的角色编账号。
 *
 * 非空且不用邮箱格式 —— 一眼能看出它是模拟器的身份，而不是某个真人。
 */
export const SIM_OWNER_USER_ID = 'user_sim_task_group';
export const SIM_DEVICE_ID = 'device_sim_task_group';

export function readJsonl(path, label) {
  if (!existsSync(path)) throw new Error(`${label}_missing:${path}`);
  return readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${label} 第 ${index + 1} 行不是合法 JSON：${error.message}`);
      }
    });
}

/**
 * 提交前的本地复核。**三个方向，各自防的失败不一样。**
 *
 * ## 1. `truncation` —— 裁过头了（历史上真发生过，这是最该防的一条）
 *
 * 白名单曾经写成 `['domain','title','nodes','edges']`，而真实 case 是
 * `{id, G_star:{nodes,edges}, G_prime:{nodes,edges}}`，于是**每一条**载荷都被裁成空对象。
 * 它不报错、不抛异常：云侧正常入队、worker 正常领活，只是拿到的 case 里什么都没有。
 * 所以这里数节点数——对不上就是硬失败。
 *
 * ## 2. `droppedFields` —— 静默丢字段（上报，不阻断）
 *
 * 输入侧有白名单外的字段（语料节点的 `role`、`prompt`…），会被**静默裁掉**。
 * 裁掉不是泄漏，但"我们以为发了 12 个字段、实际发了 11 个"必须看得见 ——
 * 否则模型因为少读一个字段而答错时，没人分得清是模型不行还是我们没发。
 *
 * ## 3. `hits` —— 输出侧越界（**在本地几乎不可能响**，别把它当成防线）
 *
 * 输出是 `buildRdmdCloudPayload` 按白名单拼的，所以它里面出现白名单外的键是自相矛盾的。
 * 第一版把这一条当成主要防线，实际是一条永远绿、也永远不可能红的断言。
 * 它真正的用处是对**从库里读回来的** `case_json` 再跑一遍 —— 那时它才在防
 * "有别的代码路径往那张表写了行"。见 `submitAll` 里的 readback。
 */
export function auditPayload(caseValue) {
  const payload = buildRdmdCloudPayload({ case: caseValue });
  return {
    payload,
    hits: auditRdmdCloudPayload(payload),
    droppedFields: auditRdmdCloudPayload(caseValue),
    truncation: describeTruncation(caseValue, payload),
  };
}

/** 载荷有没有被裁过头。判据是"该在的东西在不在、数量对不对"。 */
export function describeTruncation(caseValue, payload) {
  const problems = [];
  if (!payload.id) problems.push('id_missing');
  for (const side of ['G_star', 'G_prime']) {
    const source = caseValue[side] || {};
    const got = payload[side] || {};
    if (!Array.isArray(got.nodes)) { problems.push(`${side}_nodes_missing`); continue; }
    const expectedNodes = (source.nodes || []).length;
    if (got.nodes.length !== expectedNodes) {
      problems.push(`${side}_nodes_truncated:${got.nodes.length}/${expectedNodes}`);
    }
    const expectedEdges = (source.edges || []).length;
    if ((got.edges || []).length !== expectedEdges) {
      problems.push(`${side}_edges_truncated:${(got.edges || []).length}/${expectedEdges}`);
    }
    // 节点上的关键字段也要抽查：整对象被裁成 `{id}` 时数量是对的，但模型读不到东西。
    const sampleNode = (got.nodes || []).find((node) => node.kind === 'agent_task') || got.nodes[0];
    if (sampleNode) {
      for (const field of ['title', 'agentId', 'status']) {
        if (!sampleNode[field]) problems.push(`${side}_node_field_missing:${field}`);
      }
    }
  }
  return problems;
}

/** 把一批 case 组装成要写库/要提交的东西。**纯函数**，可在没有网络的机器上测试。 */
export function planBatches({ cases, briefs, limit = 0 }) {
  const byBrief = Object.fromEntries((briefs || []).map((brief) => [brief.id, brief]));
  const selected = limit > 0 ? cases.slice(0, limit) : cases;
  const batches = [];
  const problems = [];
  // 输入侧被白名单裁掉的字段名 → 次数。按**字段名**聚合而不是列路径：
  // 32 个节点各带一个 `role` 会刷出 32 条同样的路径，淹掉真正的新发现。
  const droppedFields = {};
  for (const sample of selected) {
    const brief = byBrief[sample.brief_id];
    if (!brief) {
      problems.push({ caseId: sample.id, reason: `brief_not_found:${sample.brief_id}` });
      continue;
    }
    const graphId = `sim_${sample.graph_id}`.slice(0, 160);
    const caseValue = { id: graphId, G_star: sample.G_star, G_prime: sample.G_prime };
    const audit = auditPayload(caseValue);
    // 裁过头 = 硬失败（历史上白名单写法错误就是这种，且完全静默）。
    if (audit.truncation.length) {
      problems.push({ caseId: sample.id, reason: 'payload_truncated', detail: audit.truncation.slice(0, 5) });
    }
    // 输出侧越界。本地几乎不可能响；留着是因为它在 readback 那条路（库里读回来的
    // case_json）才是真防线，而这里顺带便宜地过一遍。
    if (audit.hits.length) problems.push({ caseId: sample.id, reason: 'payload_leak', hits: audit.hits.slice(0, 10) });
    for (const hit of audit.droppedFields) {
      const field = String(hit).replace(/^\$.*?\.([A-Za-z_][A-Za-z0-9_]*)(?: \(.*)?$/, '$1');
      droppedFields[field] = (droppedFields[field] || 0) + 1;
    }
    batches.push({
      caseId: sample.id,
      graphId,
      taskRunId: graphId,
      briefId: sample.brief_id,
      orgId: sample.org_id,
      kind: sample.plan?.kind || '',
      tier: sample.plan?.tier || '',
      split: sample.split,
      visibility: sample.visibility,
      gold: {
        status: sample.label.status,
        nodeId: sample.label.injected_node || '',
        type: sample.label.injected_type || '',
        nodes: sample.label.injected_nodes || [],
        types: sample.label.injected_types || [],
        inserted_nodes: sample.label.inserted_nodes || [],
      },
      caseValue,
      rows: graphRows({
        graph: sample.G_star,
        graphId,
        ownerUserId: SIM_OWNER_USER_ID,
        taskRunId: graphId,
      }),
      skippedEdges: graphRows({
        graph: sample.G_star, graphId, ownerUserId: SIM_OWNER_USER_ID,
      }).skippedEdges,
    });
  }
  return { batches, problems, droppedFields };
}

/**
 * 主流程。
 *
 * 顺序有意为之：**先写图、再提交**。反过来的话，提交成功而写图失败会留下一条
 * 无法回指的作业；而先写图失败的话我们连提交都不做，队列里不会留下垃圾。
 */
export async function submitAll({
  casesPath = DEFAULT_CASES, briefsPath = DEFAULT_BRIEFS, jobsPath = DEFAULT_JOBS,
  api = process.env.RDMD_API || 'http://127.0.0.1:8787',
  limit = 0, dryRun = false, skipStore = false, quiet = false,
  // 注入点。默认走真实实现；测试用假 pool/假 HTTP 把**非干跑**那条路也走一遍 ——
  // 见 `submit.test.mjs`：`skippedStore is not defined` 这种错就是"只有真 Postgres
  // 才走到那几行"造成的，本地全绿、盒子上第一次提交才炸。
  pool: injectedPool = null, http = null,
} = {}) {
  const cases = readJsonl(casesPath, 'cases');
  const briefs = existsSync(briefsPath) ? readJsonl(briefsPath, 'briefs') : [];
  const { batches, problems, droppedFields } = planBatches({ cases, briefs, limit });
  if (problems.length) {
    // 输出侧越界就**不提交**：那是"本地就发现载荷里有白名单装不下的东西"，
    // 提交出去等于把越界内容送进云运维的库。
    throw new Error(`sim_submit_precheck_failed:${JSON.stringify(problems.slice(0, 5))}`);
  }
  if (dryRun) {
    return {
      dryRun: true, api, submitted: 0, stored: 0, batches: batches.length,
      kinds: tally(batches, (batch) => batch.kind),
      graphSizes: batches.map((batch) => batch.rows.nodes.length),
      skippedEdges: batches.flatMap((batch) => batch.skippedEdges),
      droppedFields,
      problems,
    };
  }

  // 注入了 pool 就不需要 DATABASE_URL（测试走这条），否则必须显式报错：
  // "提交要在 remote.env 生效的环境里跑"是个容易踩的坑（直接 `node submit.mjs` 会连不上库）。
  if (!injectedPool && !process.env.DATABASE_URL) throw new Error('DATABASE_URL 未设置：提交要在 remote.env 生效的环境里跑');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET 未设置');

  const httpGet = http?.get || get;
  const httpPost = http?.post || post;
  const provisionFn = http?.provision || provision;

  const pool = injectedPool || createPgPool(process.env.DATABASE_URL);
  const results = [];
  try {
    // sim 身份的 users 行 + 设备 grant。用真签名函数，不抄近路。
    await pool.query(
      `INSERT INTO users (id,email,display_name,password_hash,email_verified,role)
       VALUES ($1,$2,$3,$4,true,'member')
       ON CONFLICT (id) DO UPDATE SET display_name=excluded.display_name, updated_at=now()`,
      [SIM_OWNER_USER_ID, 'sim-task-group@sim.invalid', 'Sim Task Group', 'not-a-real-hash'],
    );
    const grant = await provisionFn(pool, { userId: SIM_OWNER_USER_ID, deviceId: SIM_DEVICE_ID });
    const token = signAccessToken({ userId: SIM_OWNER_USER_ID, secret: process.env.JWT_SECRET, expiresInSeconds: 3600 });

    const health = await httpGet('/healthz');
    if (health.status !== 200) throw new Error(`sim_api_not_healthy:${health.status}`);

    let stored = 0;
    for (const batch of batches) {
      if (!skipStore) {
        await writeGraph(pool, batch.rows);
        stored += 1;
      }
      const response = await httpPost('/api/rdmd/jobs', {
        taskRunId: batch.taskRunId,
        case: batch.caseValue,
        // 空串 = 非私有会话。这是**桌面端实际发的值**（`planExecDriftService.js` 对非私有
        // 会话发空串）。发 'collaboration' 会被云侧放行，发 'group_task' 会被当成
        // 未知类型拒掉 —— 后者曾经让一份 E2E 得出"云侧把群任务拒了"的错误结论。
        conversationKind: '',
      }, { token });
      if (response.status !== 201) {
        throw new Error(`sim_submit_failed:${batch.caseId}:${response.status}:${JSON.stringify(response.body).slice(0, 300)}`);
      }
      results.push({
        caseId: batch.caseId, graphId: batch.graphId, jobId: response.body.jobId,
        status: response.body.status, reason: response.body.reason || '',
        gold: batch.gold, kind: batch.kind, tier: batch.tier, split: batch.split,
        visibility: batch.visibility, orgId: batch.orgId, briefId: batch.briefId,
        nodes: batch.rows.nodes.length, edges: batch.rows.edges.length,
        skippedEdges: batch.skippedEdges.length,
      });
      if (!quiet && results.length % 100 === 0) {
        console.log(`[sim-submit] ${results.length}/${batches.length} 已提交`);
      }
    }

    mkdirSync(dirname(jobsPath), { recursive: true });
    writeFileSync(jobsPath, `${results.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    // 落库之后**读回来**核对两件事：
    //   1. 「写成功」不等于「读得出来」—— "图上没有链"这类失败只在读的时候现形；
    //   2. `case_json` 从库里读回来再过一遍**输出侧**审计。这才是 `auditRdmdCloudPayload`
    //      真正的用武之地：本地那份载荷是白名单拼的、不可能越界，而库里那份可能被
    //      **别的代码路径**写过。这里查的就是"表里到底躺了什么"。
    const samples = [];
    const readbackLeaks = [];
    for (const row of results.slice(0, 5)) {
      samples.push({ graphId: row.graphId, ...(await readGraphSummary(pool, row.graphId)) });
      const persisted = (await pool.query(
        'SELECT case_json FROM cloud_rdmd_inference_jobs WHERE id=$1', [row.jobId],
      )).rows[0]?.case_json;
      const parsed = typeof persisted === 'string' ? JSON.parse(persisted) : persisted;
      const leaks = auditedPayload(parsed);
      if (leaks.length) readbackLeaks.push({ jobId: row.jobId, leaks: leaks.slice(0, 5) });
    }
    if (readbackLeaks.length) {
      // 这是真泄漏，必须炸：库里躺着白名单外的东西，说明有另一条写入路径绕过了白名单。
      throw new Error(`sim_submit_readback_leak:${JSON.stringify(readbackLeaks.slice(0, 3))}`);
    }

    const report = {
      api, submitted: results.length, stored, skipStore,
      jobsPath,
      kinds: tally(results, (row) => row.kind),
      byStatus: tally(results, (row) => row.status),
      byVisibility: tally(results, (row) => row.visibility),
      skippedEdgeTotal: results.reduce((sum, row) => sum + row.skippedEdges, 0),
      droppedFields,
      graphReadback: samples,
      problems,
    };
    if (!quiet) {
      console.log(`[sim-submit] 提交 ${report.submitted} 条，写图 ${report.stored} 张`);
      console.log(`[sim-submit] status=${JSON.stringify(report.byStatus)} kinds=${JSON.stringify(report.kinds)}`);
      if (report.skippedEdgeTotal) console.log(`[sim-submit] 被跳过的边 ${report.skippedEdgeTotal} 条（不属于产品的边语汇）`);
      console.log(`[sim-submit] jobs -> ${jobsPath}`);
    }
    return report;
  } finally {
    // 注入的 pool 由调用方负责关；我们去关它会把测试/宿主的连接池弄坏。
    if (!injectedPool) await pool.end();
  }
}

/** 从库里读回来的载荷过一遍白名单审计。这才是这条审计的用武之地（见文件头）。 */
function auditedPayload(persisted) {
  return persisted ? auditRdmdCloudPayload(persisted) : [];
}

function tally(rows, fn) {
  const out = {};
  for (const row of rows) {
    const key = fn(row) || '(空)';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function parseArgs(argv) {
  const args = { casesPath: DEFAULT_CASES, briefsPath: DEFAULT_BRIEFS, jobsPath: DEFAULT_JOBS, limit: 0, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--cases') args.casesPath = resolve(argv[++i]);
    else if (token === '--briefs') args.briefsPath = resolve(argv[++i]);
    else if (token === '--jobs') args.jobsPath = resolve(argv[++i]);
    else if (token === '--api') args.api = argv[++i];
    else if (token === '--limit') args.limit = Number(argv[++i]) || 0;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--skip-store') args.skipStore = true;
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法: node experiments/sim_task_group/submit.mjs [选项]
  --cases <path>   generated.jsonl，缺省 experiments/sim_task_group/out/generated.jsonl
  --briefs <path>  briefs.jsonl（用来把 case 关联回组织与人）
  --jobs <path>    作业清单输出，缺省 out/jobs.jsonl
  --api <url>      云 API，缺省 $RDMD_API 或 http://127.0.0.1:8787
  --limit <n>      只提交前 n 条
  --dry-run        只做本地装配与隐私审计，不连库不发请求
  --skip-store     不写 collaboration_graph_*（只用于对比"有根/无根"）
  --json           报告打到 stdout`);
    process.exit(0);
  }
  submitAll(args)
    .then((report) => {
      if (args.json) console.log(JSON.stringify(report, null, 2));
      console.log('SIM_SUBMIT_OK');
    })
    .catch((error) => {
      console.error(`SIM_SUBMIT_FAILED ${error?.stack || error}`);
      process.exit(1);
    });
}
