import {
  DRIFT_TYPES,
  cloneRichGraph,
  descendantsOf,
  hopDistance,
  incoming,
  maxHopFrom,
  normalizeRichGraph,
  siblingInjectablePairs,
  topoIds,
} from './graph.mjs';
import { SCHEMA } from './graph.mjs';
import { applyFormFar, applyFormToNode, formIdOf, lookupForm, pickForm, stepFormAvailable } from './forms.mjs';
import { obfuscateGraph } from './obfuscate.mjs';
import { makeRng } from './rng.mjs';

const DOMAINS = [
  ['research', '行业研究', [
    '立项与范围', '列问题清单', '检索策略', '收集公开资料', '补一手访谈',
    '来源分级', '交叉验证', '证据卡', '数据窗口确认', '写发现摘要',
    '整理引用', '异议记录', '形成结论', '内部预审', '口径对齐',
    '图表需求', '报告正文', '附录材料', '质量清单', '对外交付', '归档复盘',
  ]],
  ['data', '数据处理', [
    '盘点源系统', '拉原始表', '对字段字典', '字段清洗', '缺失值处理',
    '主键对齐', '一致性校验', '异常值规则', '特征整理', '切分样本',
    '血缘登记', '质量门禁', '权限标注', '发布数据集', '使用说明',
    '抽样复核', '下游试跑', '回滚准备', '冻结版本', '交接值班', '复盘缺口',
  ]],
  ['writing', '报告写作', [
    '收齐素材', '列提纲', '锁读者', '组织论据', '起草正文',
    '补证据', '统一术语', '语言润色', '事实核验', '图表配合',
    '摘要重写', '脚注整理', '交叉引用', '内部预读', '按意见改',
    '体例检查', '定稿', '导出版本', '分发名单', '归档原稿', '复盘可读性',
  ]],
  ['ppt', '演示文稿', [
    '抽关键结论', '定听众', '设计结构', '写每页主张', '准备数据',
    '绘制图表', '选视觉母版', '排版关键页', '写讲稿要点', '控制时长',
    '统一视觉', '核对数字', '预演翻页', '问答预案', '打印备份',
    '排练检查', '按反馈改', '导出投屏版', '导出讲者版', '现场清单', '会后归档',
  ]],
  ['code', '功能开发', [
    '澄清需求', '划边界', '设计接口', '补错误码', '搭骨架',
    '实现核心逻辑', '接依赖', '补测试', '跑主路径', '跑失败分支',
    '代码评审', '按意见改', '更新说明', '合并发布', '观察日志',
    '修回归', '打补丁', '冻结标签', '交接值班', '写变更', '复盘缺陷',
  ]],
  ['review', '质量评审', [
    '领取材料', '核对版本', '对照清单', '抽关键页', '标出风险',
    '定严重级', '要求补证', '等修改', '复核修改', '查遗留',
    '独立会签', '汇总意见', '出具结论', '跟踪关闭', '归档清单',
    '通知作者', '抽查关闭项', '升级未关项', '写评审纪要', '复盘漏项', '更新清单',
  ]],
  ['ops', '上线运营', [
    '准备环境', '核配额', '配置发布', '检查开关', '灰度名单',
    '灰度观察', '看错误率', '收集故障', '判定回滚', '回滚或放量',
    '扩观察窗', '核对告警', '写运行说明', '交接值班', '复盘事故',
    '补监控', '冻结构', '清临时配置', '更新手册', '归档变更', '演练回退',
  ]],
  ['legal', '合规审查', [
    '识别数据范围', '对照许可', '检查授权', '标敏感项', '提出限制',
    '核对对外口径', '看脱敏', '查留存期', '会签业务', '确认使用边界',
    '写限制条款', '归档许可', '通知使用方', '抽查落地', '处理例外',
    '更新法规摘', '复核旧档', '关闭过期许可', '对外说明', '复盘漏洞', '培训口径',
  ]],
  ['marketing', '活动策划', [
    '定目标人群', '定转化目标', '选渠道', '核权益', '写文案',
    '做法务预审', '做物料', '齐套检查', '排期投放', '打点校验',
    '小流量试', '看投诉', '调预算', '扩量或停', '效果复核',
    '归因核对', '素材复盘', '归档成片', '结算渠道', '更新人群包', '写结案',
  ]],
  ['hr', '招聘流程', [
    '拆岗位要求', '锁必备项', '发职位', '收简历', '筛简历',
    '安排面试', '对岗一轮', '协作轮', '记录评价', '对齐分歧',
    '背景核对', '薪酬带宽', '审批要约', '发offer', '谈条件',
    '收书面确认', '入职清单', '交接用人经理', '关闭职位', '归档评价', '复盘漏招',
  ]],
];

const TOPICS = [
  '2025市场简报', '季度复盘', '竞品对比', '用户访谈纪要', '发票核销', '实验记录',
  '开源组件升级', '客户答疑包', '融资材料', '新品发布', '安全巡检', '合同附件',
  '渠道对账', '课程大纲', '运维值班', '学术综述', '设计走查', '数据字典',
  '隐私影响评估', '灰度放量', '薪酬带宽调整', '品牌投放',
];

const STRUCTURES = ['linear', 'fork_join', 'late_diamond', 'side_track'];

// ---------------------------------------------------------------------------
// 群任务形状（四层：root -> ubuddy -> agent_task -> agent_step）
// ---------------------------------------------------------------------------
//
// 为什么要有这一族：产品侧的协作图就是这四层，而且 agent 的执行规划是以一条
// `sequence_of` 链挂在 agent_task 下面的 —— 那是整张图上**唯一的真链**来源
// （见 PLAN_EXEC_TRUTH.zh-CN.md 第 2 节）。旧的四种形状全是"叶子平铺"，
// 模型没见过"容器 -> 工作单元 -> 子步骤链"，也就学不到"漂移沿链传播"这个唯一因果形状。
//
// 它和旧族共用同一套 11 字段内容（`publicGraph` 会丢掉 kind），差别只在**骨架**：
// 容器层与工作单元层分开、子步骤成链、并行协作线真的并行。
const SUB_STEP_LABELS = ['列要点', '取证', '核对口径', '写摘要', '交叉验证', '留痕'];

// 三条协作线。[深链] 负责把"从 root 起的最长跳数"顶过 8（v3 的语料不变量），
// [普通线] 让"并行协作"这个形状真的出现，[最小线] 让分支宽度不均匀。
// 深链的步数在 6–8 之间抖：全都一样长的话，"最长的链 = 6"就成了常数背景，
// 骨架层面的变化消失，只剩凶手在变。
const LAYERED_BRANCHES = [
  { tasks: 3, steps: [2, 2, 'deep'] },
  { tasks: 2, steps: [2, 3] },
  { tasks: 1, steps: [2] },
];

/**
 * 这一族占多少比例。默认一半：整条链路的目标是群任务，语料必须有一半是它的形状。
 *
 * 用 index 的自己散列而不是 rng 决定：一是同一 index 必须恒定（缓存与测试都靠它），
 * 二是不能和 `index % DOMAINS.length` / `index % TOPICS.length` 的轮转共振 ——
 * 直接用奇偶会让"群任务"和固定的那几个业务域绑死。
 */
export function usesGroupShape(index, share = SCHEMA.groupShare ?? 0.5) {
  if (!(share > 0)) return false;
  if (share >= 1) return true;
  return ((((index + 1) * 2654435761) % 1000) / 1000) < share;
}

export function generateGoldenGraph(index, seed = 1, { groupShare = SCHEMA.groupShare ?? 0.5 } = {}) {
  const rng = makeRng(seed * 10007 + index + 17);
  const [domain, domainTitle, steps] = DOMAINS[index % DOMAINS.length];
  const topic = TOPICS[Math.floor(index / DOMAINS.length) % TOPICS.length];
  if (usesGroupShape(index, groupShare)) {
    const plan = layeredGroupPlan({ domain, domainTitle, topic, steps, seed, index });
    return obfuscateGraph(normalizeRichGraph({
      graph_id: `rdmd_${domain}_${index}`,
      domain,
      title: `${domainTitle}：${topic}`,
      topic,
      nodes: plan.nodes,
      edges: plan.edges,
    }), seed * 7919 + index * 31 + 5);
  }
  const structure = STRUCTURES[Math.floor(index / (DOMAINS.length * TOPICS.length)) % STRUCTURES.length];
  const drop = rng.int(3);
  const titles = steps.slice(0, steps.length - drop);
  while (titles.length < SCHEMA.nodeCount.starMin) titles.push(`收尾核对${titles.length + 1}`);
  const nodes = titles.map((title, offset) => {
    const stage = stageName(offset, titles.length);
    return {
      id: `n${offset + 1}`,
      title,
      role: domain,
      agentId: `${domain}_agent_${offset + 1}`,
      version: 'v1',
      acceptance: 'standard',
      artifact: `${topic}-${title}`,
      stage,
      inputs: offset === 0 ? `${topic}任务说明` : `${titles[offset - 1]}的产出`,
      output: `${title}产出（${topic}）`,
      summary: `在「${topic}」中完成「${title}」，所属域：${domainTitle}，阶段：${stage}。`,
    };
  });
  const edges = makeStructure(nodes.map((node) => node.id), structure, rng);
  // v3: break the id-order / array-order positional shortcut. Node ids and the rendered
  // node order are shuffled so they carry no topological information.
  return obfuscateGraph(normalizeRichGraph({
    graph_id: `rdmd_${domain}_${index}`,
    domain,
    title: `${domainTitle}：${topic}`,
    topic,
    nodes,
    edges,
  }), seed * 7919 + index * 31 + 5);
}

/**
 * 四层骨架。返回 `{nodes, edges}`，节点的 11 个内容字段全部填满 ——
 * 这是语料的硬不变量（也是产品侧守卫的判据：空字段 = 落在训练支持集外）。
 *
 * 注意**没有** `status` 字段：`status` 在语料里是标签（`forbiddenGraphKeys`），
 * 节点上的执行状态由产品侧自己维护，不进模型契约。
 */
function layeredGroupPlan({ domain, domainTitle, topic, steps, seed = 1, index = 0 }) {
  // 骨架层面留一点变化：深链步数在 6–8 之间。这里用 `mixSeed` 而不是 `makeRng` ——
  // LCG 对相邻种子的第一次取值几乎相同，`seed + index` 这种线性种子会在几百个 index 上
  // 给出同一个值，抖动就成了摆设（同一个坑在 pickInjection 里也踩过一次）。
  const deepSteps = 6 + (mixSeed(seed * 7919 + index * 31) % 3);
  const nodes = [];
  const edges = [];
  const link = (from, to) => edges.push({ id: `${from}->${to}`, from, to });
  let counter = 0;
  const nextId = () => `n${(counter += 1)}`;
  const content = (title, suffix) => ({
    artifact: `${topic}-${title}${suffix}`,
    output: `${title}产出（${topic}）`,
    summary: `在「${topic}」中完成「${title}」，所属域：${domainTitle}。`,
  });

  const rootId = nextId();
  nodes.push({
    id: rootId,
    kind: 'root',
    title: `组织「${topic}」协作`,
    role: domain,
    agentId: `${domain}_ubuddy`,
    version: 'v1',
    acceptance: 'standard',
    stage: '准备',
    inputs: `${topic}任务说明`,
    ...content(`组织「${topic}」协作`, ''),
  });

  // 任务标题从该域的步骤表里取，且**均匀取**：这样"协作线"覆盖任务的早期/中期/交付段，
  // 不会出现所有任务都挤在同一阶段。
  const taskSlots = LAYERED_BRANCHES.reduce((sum, branch) => sum + branch.tasks, 0);
  const taskTitles = [];
  for (let k = 0; k < taskSlots; k += 1) {
    taskTitles.push(steps[Math.floor(((k + 1) * (steps.length - 1)) / (taskSlots + 1))]);
  }

  let taskCursor = 0;
  LAYERED_BRANCHES.forEach((branch, branchIndex) => {
    const hubId = nextId();
    const hubTitle = `协作线${branchIndex + 1}：${taskTitles[taskCursor]}`;
    nodes.push({
      id: hubId,
      kind: 'ubuddy',
      title: hubTitle,
      role: domain,
      agentId: `${domain}_ubuddy_${branchIndex + 1}`,
      version: 'v1',
      acceptance: 'standard',
      stage: '准备',
      inputs: `组织「${topic}」协作的产出`,
      ...content(hubTitle, ''),
    });
    link(rootId, hubId);

    let prevTaskId = '';
    for (let t = 0; t < branch.tasks; t += 1) {
      const taskId = nextId();
      const taskTitle = taskTitles[taskCursor] || `协作线${branchIndex + 1}任务${t + 1}`;
      taskCursor += 1;
      const agentId = `${domain}_agent_${branchIndex + 1}_${t + 1}`;
      nodes.push({
        id: taskId,
        kind: 'agent_task',
        title: taskTitle,
        role: domain,
        agentId,
        version: 'v1',
        acceptance: 'standard',
        stage: stageName(t, Math.max(1, branch.tasks - 1)),
        inputs: `协作线${branchIndex + 1}的产出`,
        ...content(taskTitle, ''),
      });
      // 同一条线上后一个任务依赖前一个任务：这是 dependency_of 边，
      // 和 sequence_of（步骤链）是两种不同的边，但语料的边只存 from/to
      // （模型与「相近度」度量都只看到这一层），所以这里不区分。
      link(prevTaskId || hubId, taskId);
      prevTaskId = taskId;

      // 'deep' = 这条线的最后一个任务挂 6–8 步的长链，负责把最深跳数顶过 8。
      const stepCount = branch.steps[t] === 'deep' ? deepSteps : (branch.steps[t] || 2);
      let prevStepId = '';
      for (let s = 0; s < stepCount; s += 1) {
        const stepId = nextId();
        const label = SUB_STEP_LABELS[s % SUB_STEP_LABELS.length];
        const stepTitle = `${taskTitle}·${label}`;
        // ── v4：agent_step 只写真实投影真的会写的字段 ──────────────────────
        //
        // 实测来源（_real_live/AGENT_PLAN_OBSERVATION.zh-CN.md §4.2，一个真实 task run
        // 上跑出来的四层图）：
        //   title     ← 步骤名（projectAgentPlanSteps: sanitizeCollaborationPublicValue(label)）
        //   status    ← 执行状态（同处；被后续计划版本砍掉的步骤会被标成 cancelled）
        //   agentId   ← **继承**自所属任务（ownerAgentId = parent.agentId），有值但不是独立信号
        //   publicSummary 恒空；artifact / stage / inputs / output 无对应列；role 只有 kind
        //
        // 所以这里**一个富文本字段都不写**。v3 往 step 节点写满 artifact/output/summary/inputs
        // 是这一族最大的错配：语料读满字段、上线拿到空字段，模型在训练里学会的归因依据
        // 在生产上一个都不存在。归一化会补 version='v1' / acceptance='standard'，
        // 那与产品侧 PLAN_EXEC_CONSTANTS 逐字一致，属于同一类"常量而非信号"。
        nodes.push({
          id: stepId,
          kind: 'agent_step',
          title: stepTitle,
          agentId,
        });
        link(prevStepId || taskId, stepId);
        prevStepId = stepId;
      }
    }
  });

  return { nodes, edges };
}

export function applyLocalEdit(graph, type, nodeId, seed = 1) {
  const rng = makeRng(seed);
  const next = cloneRichGraph(graph);
  const node = next.nodes.find((item) => item.id === nodeId);
  if (!node || !DRIFT_TYPES.includes(type)) return { graph: next, gold: null };
  const domain = next.domain || node.role || 'research';
  const topic = next.topic || guessTopic(next);
  const form = pickForm(domain, type, rng, { kind: node.kind });
  // step 层没有对应形态时**必须放弃**，不能回落到 domain 目录。
  // 回落会把 artifact/output/summary 写到 step 节点上，造出一个产品上不存在的形状
  // （真实投影在 step 层一个字都不写），而模型会去学那个形状。
  // 现在这一档是 wrong_acceptance：plan step 只有 `{step,status}`，没有验收概念的来源。
  if (!form) return { graph: next, gold: null };
  const ctx = { domain, topic, type, minHop: SCHEMA.minHopToFirstEffect, kind: node.kind };
  const gold = {
    nodeId,
    type,
    edgeId: '',
    formId: formIdOf(domain, type, form),
    domain,
    topic,
    minHop: ctx.minHop,
  };
  if (type === 'missing_dependency') {
    const inbound = next.edges.filter((edge) => edge.to === nodeId);
    // agent_step 的入边有两种：来自所属任务（包含）与来自前一个步骤（链）。
    // 「缺依赖」只能是后者 —— 砍掉包含边只会把这一步变成孤立源点，那不是漂移，
    // 是数据坏了。链首步骤没有前驱，就干脆不给它注入这一类，让采样器换点。
    const chosen = node.kind === 'agent_step'
      ? inbound.find((edge) => kindOf(next, edge.from) === 'agent_step')
      : inbound[0];
    if (!chosen) return { graph: next, gold: null };
    gold.edgeId = chosen.id;
    next.edges = next.edges.filter((edge) => edge.id !== chosen.id);
  }
  applyFormToNode(node, form, ctx);
  if (type === 'local_replan' && node.kind === 'agent_step') {
    gold.insertedNodeId = insertLocalReplanStep(next, nodeId, seed);
  }
  gold.form = form;
  return { graph: next, gold };
}

export function inferDownstream(star, edited, gold, { seed = 1, subtle = false } = {}) {
  const rng = makeRng(seed);
  const next = cloneRichGraph(edited);
  const minHop = gold.minHop || SCHEMA.minHopToFirstEffect;
  const form = gold.form || lookupForm(gold.domain || star.domain, gold.type, gold.formId);
  const ctx = { domain: gold.domain || star.domain, topic: gold.topic || star.topic, type: gold.type, minHop };
  const far = descendantsOf(star, gold.nodeId)
    .map((id) => ({ id, hop: hopDistance(star, gold.nodeId, id) }))
    .filter((item) => Number.isFinite(item.hop) && item.hop >= minHop);
  const pickCount = Math.max(2, Math.min(far.length, Math.ceil(far.length * rng.range(0.35, 0.75))));
  const chosen = new Set(rng.sample(far.map((item) => item.id), pickCount));
  if (far.length && ![...chosen].some((id) => far.find((item) => item.id === id)?.hop >= minHop)) {
    chosen.add(far[0].id);
  }
  for (const { id } of far) {
    if (!chosen.has(id)) continue;
    const node = next.nodes.find((item) => item.id === id);
    if (!node) continue;
    applyFormFar(node, form, ctx);
  }
  if (!subtle && form.repair && rng.bool(0.55)) {
    const loudParent = far.find((item) => chosen.has(item.id));
    if (loudParent) addRepair(next, loudParent.id, form, ctx);
  }
  if (subtle) {
    const orig = star.nodes.find((item) => item.id === gold.nodeId);
    const cur = next.nodes.find((item) => item.id === gold.nodeId);
    // step 节点**不能**被"subtle"抹平。step 层收窄之后，title 与 agentId 就是真凶
    // 唯一的两个信号通道（富文本已经不在这一层了），抹掉等于把样本变成无解的。
    // 平铺/富文本层照旧：那里还有 artifact/output/summary 撑着，抹掉措辞不伤因果。
    if (orig && cur && gold.type !== 'missing_dependency' && cur.kind !== 'agent_step') {
      cur.title = orig.title;
      cur.agentId = orig.agentId;
      cur.version = orig.version;
      cur.acceptance = orig.acceptance;
    }
  }
  return normalizeRichGraph(next);
}

/**
 * v3 innocent-twin decoys.
 *
 * A decoy is a NEW side node grafted onto a node that is neither the culprit nor a
 * descendant of it. It carries a plausible substantive-looking change (its own agentId,
 * artifact and summary) but has no descendants, so its edit cannot explain any visible
 * cascade. This kills "lowest id", "first in array order" and "the node whose agentId
 * changed" style shortcuts; the only way to exclude a decoy is to check which changed node
 * actually has downstream consequences.
 */
export function addDecoyNodes(star, prime, gold, { seed = 1, count = 0 } = {}) {
  const rng = makeRng(seed);
  const next = cloneRichGraph(prime);
  const goldIds = (Array.isArray(gold) ? gold : [gold]).filter(Boolean);
  const inCascade = new Set(goldIds);
  for (const goldId of goldIds) {
    for (const id of descendantsOf(star, goldId)) inCascade.add(id);
    for (const id of descendantsOf(next, goldId)) inCascade.add(id);
  }
  const pool = next.nodes.filter((node) => !inCascade.has(node.id));
  if (!pool.length) return { graph: normalizeRichGraph(next), decoys: [] };
  const wanted = count || (rng.bool(0.72) ? 1 : 2);
  const chosen = rng.sample(pool, Math.min(wanted, pool.length));
  const used = next.nodes.flatMap((node) => String(node.id).match(/\d+/g) || []).map(Number);
  let label = Math.max(0, ...used.filter(Number.isFinite));
  const decoys = [];
  for (const source of chosen) {
    label += 1 + rng.int(4);
    const id = `n${label}`;
    const topic = next.topic || '';
    // 诱饵必须挂在**真实可能出现的形状**上。step 节点的子节点只可能是 step
    // （sequence_of），在它下面挂一个带 artifact/summary 的富文本节点是一个
    // 产品上不可能出现的结构，模型会去学那个结构 —— 那比没有诱饵更糟。
    if (source.kind === 'agent_step') {
      next.nodes.push({
        id,
        kind: 'agent_step',
        title: `${source.title}·补一步复核`,
        // agentId 仍然继承自所属任务：step 的执行者不独立于任务，
        // 这正是"step 上的 wrong_agent 只可能是有人越权代跑"这个形态成立的前提。
        agentId: source.agentId,
      });
      next.edges.push({ id: `${source.id}->${id}`, from: source.id, to: id });
      decoys.push(id);
      continue;
    }
    const title = `${source.title}复核备注`;
    next.nodes.push({
      id,
      title,
      role: source.role,
      agentId: `${source.role}_agent_${label}`,
      version: 'v1',
      acceptance: 'standard',
      artifact: `${topic}-${title}`,
      stage: '整合',
      inputs: `${source.title}的产出`,
      output: `${title}产出（${topic}）`,
      summary: `对「${source.title}」的产出补一份旁支复核备注，不并入主交付链。`,
    });
    next.edges.push({ id: `${source.id}->${id}`, from: source.id, to: id });
    decoys.push(id);
  }
  return { graph: normalizeRichGraph(next), decoys };
}

/**
 * 注入点至少要有多少跳的下游余量。
 *
 * 平铺族用 `minPathNeeded()`（6 跳）：那是为了让"首效延迟 + 远处级联"都留得下。
 * 但四层图里最深的节点是步骤链的末端，6 跳余量只有链首几个满足 ——
 * 注入点会被全部挤到容器层，step 层就永远学不到，而 step 层正是这一族存在的理由。
 * 所以分层图放宽到硬门槛（`minHopToFirstEffect`），代价是级联更短。
 */
export function injectionFloorFor(graph) {
  return hasAgentSteps(graph) ? SCHEMA.minHopToFirstEffect : minPathNeeded();
}

export function hasAgentSteps(graph) {
  return normalizeRichGraph(graph).nodes.some((node) => node.kind === 'agent_step');
}

export function pickInjection(graph, seed = 1, preferredType = '', { floor = injectionFloorFor(graph) } = {}) {
  // 种子先散一次再进 LCG。makeRng 是线性同余，相邻种子的**第一次**取值几乎相同
  // （`cursor * 13` 与 48271 的乘积相对模数只有 0.0003），所以 makeDrift 里那条
  // `seed + cursor * 13` 的种子序列会一直落到候选表的同一个下标 —— 结果是
  // "每张图永远只在一个位置注入"，四层图里 step 层就永远当不上凶手。
  const rng = makeRng(mixSeed(seed));
  const type = DRIFT_TYPES.includes(preferredType) ? preferredType : rng.pick(DRIFT_TYPES);
  const order = topoIds(graph);
  const earlyCut = Math.max(2, Math.floor(order.length * 0.42));
  const inn = incoming(graph);
  const eligible = (id) => maxHopFrom(graph, id) >= floor;
  const hasRemovableDependency = (id) => {
    const inbound = inn.get(id) || [];
    // step 层只能砍"链"上的入边，见 applyLocalEdit 里的说明。
    if (kindOf(graph, id) === 'agent_step') return inbound.some((from) => kindOf(graph, from) === 'agent_step');
    return inbound.length > 0;
  };
  // 分层图**不做**"早期截断"：在这一族里"早期"恰好等于容器层，截断会把注入点全部锁在
  // root/ubuddy/agent_task 上，step 层永远当不上凶手 —— 而 step 层正是这一族的理由。
  // 位置本来就不该是线索：v3 的整套 obfuscate 都是为了这一点。
  const pool = hasAgentSteps(graph) ? order : order.slice(0, earlyCut);
  // step 层没有形态的漂移类型（`STEP_TIER_MISSING_FORMS`，今天只有 wrong_acceptance）
  // 必须把 step 节点排除在候选外。不排除也能"跑对"（applyLocalEdit 会返回 null），
  // 但那是靠重试碰运气，而且会让"step 层只承载 4/5 种漂移"这件事从代码里看不出来。
  const stepInjectable = stepFormAvailable(type);
  let candidates = pool.filter((id) => eligible(id) && (stepInjectable || kindOf(graph, id) !== 'agent_step'));
  if (type === 'missing_dependency') candidates = candidates.filter(hasRemovableDependency);
  if (!candidates.length) {
    candidates = order.filter((id) => eligible(id) && (stepInjectable || kindOf(graph, id) !== 'agent_step'));
    if (type === 'missing_dependency') candidates = candidates.filter(hasRemovableDependency);
  }
  if (!candidates.length) return null;
  return { type, nodeId: rng.pick(candidates) };
}

/**
 * 声明**注入本身**新增的节点。今天只有一种：`local_replan` 在 step 链上插的那一环
 * （见 `insertLocalReplanStep`）。它既不是真凶也不是诱饵，所以 `gates.mjs` 里那条
 * "新节点必须有来由"的判据需要一个显式名单 —— 声明的同时还会被结构判据再审一遍
 * （必须挂在真凶的下游），不是免检通行证。
 */
export function insertedNodesOf(gold) {
  const id = gold?.insertedNodeId;
  return id ? [id] : [];
}

export function pickForkPair(graph, seed = 1) {  const rng = makeRng(seed);
  const pairs = siblingInjectablePairs(graph).filter(([a, b]) => {
    return maxHopFrom(graph, a) >= 3 && maxHopFrom(graph, b) >= 3;
  });
  if (!pairs.length) return null;
  const [a, b] = rng.pick(pairs);
  return { a, b };
}

export function localGoldenFromPrompt(index, seed) {
  return { graph: generateGoldenGraph(index, seed), model: 'local-tutorial-writer', backend: 'local' };
}

function minPathNeeded() {
  return SCHEMA.minHopToFirstEffect + 3;
}

/**
 * 32 位整数散列（murmur3 收尾），把相邻种子打散。
 *
 * 用 `Math.imul` 而不是 `*`：`seed * 2654435761` 在 seed 上千万时会超过 2^53，
 * 结果虽然仍是确定的，但低位会被浮点精度吃掉，散列质量反过来变差。
 */
function mixSeed(seed) {
  let h = (Math.abs(Number(seed) || 1) % 2147483647) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) || 1;
}

function kindOf(graph, nodeId) {
  return normalizeRichGraph(graph).nodes.find((node) => node.id === nodeId)?.kind || '';
}

function stageName(offset, total) {
  const q = offset / Math.max(1, total - 1);
  if (q < 0.25) return '准备';
  if (q < 0.5) return '执行';
  if (q < 0.75) return '整合';
  return '交付';
}

function guessTopic(graph) {
  const title = String(graph.title || '');
  const parts = title.split('：');
  return parts[1] || title || '当期任务';
}

function makeStructure(ids, structure, rng) {
  const edges = [];
  const add = (from, to) => edges.push({ id: `${from}->${to}`, from, to });
  const n = ids.length;
  if (structure === 'linear' || n < 16) {
    for (let i = 0; i < n - 1; i += 1) add(ids[i], ids[i + 1]);
    return edges;
  }
  if (structure === 'fork_join') {
    const split = 3;
    const join = n - 4;
    for (let i = 0; i < split; i += 1) add(ids[i], ids[i + 1]);
    const mid = join - split - 1;
    const leftLen = Math.ceil(mid / 2);
    const left = [];
    const right = [];
    for (let i = 0; i < mid; i += 1) {
      (i < leftLen ? left : right).push(ids[split + 1 + i]);
    }
    if (left.length) {
      add(ids[split], left[0]);
      for (let i = 0; i < left.length - 1; i += 1) add(left[i], left[i + 1]);
      add(left[left.length - 1], ids[join]);
    } else add(ids[split], ids[join]);
    if (right.length) {
      add(ids[split], right[0]);
      for (let i = 0; i < right.length - 1; i += 1) add(right[i], right[i + 1]);
      add(right[right.length - 1], ids[join]);
    } else add(ids[split], ids[join]);
    for (let i = join; i < n - 1; i += 1) add(ids[i], ids[i + 1]);
    return uniqueEdges(edges);
  }
  if (structure === 'late_diamond') {
    const split = Math.floor(n * 0.35);
    const join = Math.floor(n * 0.72);
    for (let i = 0; i < split; i += 1) add(ids[i], ids[i + 1]);
    add(ids[split], ids[split + 1]);
    add(ids[split], ids[split + 2]);
    add(ids[split + 1], ids[join]);
    add(ids[split + 2], ids[join]);
    for (let i = split + 3; i < join; i += 1) add(ids[i], ids[i + 1]);
    if (split + 3 < join) add(ids[split + 1], ids[split + 3]);
    for (let i = join; i < n - 1; i += 1) add(ids[i], ids[i + 1]);
    return uniqueEdges(edges);
  }
  for (let i = 0; i < n - 1; i += 1) add(ids[i], ids[i + 1]);
  const sideStart = 2;
  const sideEnd = n - 5;
  if (sideEnd - sideStart >= 4) {
    add(ids[sideStart], ids[sideStart + 2]);
    add(ids[sideStart + 2], ids[sideEnd]);
  }
  if (rng.bool(0.5) && n > 18) add(ids[1], ids[2]);
  return uniqueEdges(edges);
}

function addRepair(graph, parentId, form, ctx) {
  const parent = graph.nodes.find((node) => node.id === parentId) || { id: parentId, title: parentId, output: parentId };
  const spec = form.repair(parent, ctx) || {};
  const a = `repair_${parentId}_a`;
  const b = `repair_${parentId}_b`;
  // 修补节点的形状必须跟它挂上去的那个节点同层。挂在 step 上的富文本节点
  // 在产品上不存在（步骤的子节点只可能是步骤），所以 step 的修补也只能是步骤。
  if (parent.kind === 'agent_step') {
    graph.nodes.push(
      { id: a, kind: 'agent_step', title: spec.title || '补一步接回主链', agentId: parent.agentId },
      { id: b, kind: 'agent_step', title: '接回后续步骤', agentId: parent.agentId },
    );
    graph.edges.push({ id: `${parentId}->${a}`, from: parentId, to: a });
    graph.edges.push({ id: `${a}->${b}`, from: a, to: b });
    return;
  }
  const role = ctx.domain || 'repair';
  graph.nodes.push(
    {
      id: a,
      title: spec.title || '临时接回',
      role,
      agentId: `${role}_bridge`,
      version: 'v1',
      acceptance: 'standard',
      artifact: spec.output,
      stage: '整合',
      inputs: spec.inputs || parent.output,
      output: spec.output || `${ctx.topic}-接回件`,
      summary: spec.summary || '把偏离后的产物接回主链。',
    },
    {
      id: b,
      title: '接回主链',
      role,
      agentId: `${role}_bridge`,
      version: 'v1',
      acceptance: 'standard',
      artifact: `${ctx.topic}-已接回`,
      stage: '整合',
      inputs: spec.output || `${ctx.topic}-接回件`,
      output: `${ctx.topic}-可继续产物`,
      summary: '把临时步骤接回后续交付。',
    },
  );
  graph.edges.push({ id: `${parentId}->${a}`, from: parentId, to: a });
  graph.edges.push({ id: `${a}->${b}`, from: a, to: b });
}

/**
 * 本地重规划在 step 层只能表现为「链上多了一环」。
 *
 * 为什么不是「砍掉一环」：砍掉真凶节点本身会被 `gold_absent_in_prime` 闸门拒掉
 * （真凶必须存在于两侧，否则归因无从校验），所以 step 层的 local_replan 只剩**插入**。
 * 插入的节点是 gold 的后代（`gold -> 新步 -> 原下一步`），所以它算"被解释的增点"，
 * 不会被 `extra_node_unexplained` 拦下。
 *
 * 新步的 agentId 沿用 gold 的：本地重规划不会换执行者，换执行者是 wrong_agent。
 */
/**
 * `local_replan` 在 step 链上增派的一步。
 *
 * 形状是"从这一步又派生出一个计划外的环节"，**不是**"在链中间插一环把后继接走"。
 * 后者看起来更自然，但它会改掉真凶的**出边**，而 `firstEffectHop` 把"出边变了"算作
 * 目标节点发生了变化（`changedNodeIds` 里那条 `changed.add(to)`）—— 于是首因落在
 * hop 1，撞上 `minHopToFirstEffect = 3`。要放行就得给这一类样本开个口子，而那条门
 * 的作用恰恰是"答案不许紧挨着变化点"，正是这条语料最不能松的约束之一。
 *
 * 不改任何既有边，就绕开了这个冲突：真凶的出边原封不动，级联照旧 ≥3 跳，
 * 而新增的这一步是"注入本身"长出来的节点（由 `insertedNodesOf` 显式报给 gates）。
 */
function insertLocalReplanStep(graph, goldId, seed = 1) {
  const rng = makeRng(seed);
  const gold = graph.nodes.find((node) => node.id === goldId);
  if (!gold || gold.kind !== 'agent_step') return '';
  const used = graph.nodes.flatMap((node) => String(node.id).match(/\d+/g) || []).map(Number);
  const insertedId = `n${Math.max(0, ...used.filter(Number.isFinite)) + 1 + rng.int(4)}`;
  graph.nodes.push({
    id: insertedId,
    kind: 'agent_step',
    title: `${gold.title}·临时增派一步`,
    agentId: gold.agentId,
  });
  graph.edges.push({ id: `${goldId}->${insertedId}`, from: goldId, to: insertedId });
  return insertedId;
}

function uniqueEdges(edges) {
  const seen = new Set();
  return edges.filter((edge) => {
    if (!edge.from || !edge.to || edge.from === edge.to) return false;
    const key = `${edge.from}->${edge.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
