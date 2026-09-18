// RDMD 云侧载荷的**显式字段白名单**。
//
// 为什么单独一个文件、而不是在路由里顺手拼一下：把 case 发到云，比本地读库是**质变**的
// 暴露。本地读库时数据不出设备；发到云，它离开了用户机器、进入了我们运维的数据库。
// 对这两件事用同一个"内部信任"假设，是这类系统最常见的隐私事故。
//
// 所以规则是白名单而不是黑名单：**只有这里列出的字段会被发送**，图里出现任何新字段
// 都默认不发送（而不是默认发送、事后想起来再排除）。黑名单的问题在于，它要求作者
// 预见到所有危险字段名；白名单只要求作者确认自己发了什么。
//
// 三道闸，缺一不可：
//
//   1. **会话级**：`private_assistant` 会话一律不带（`assertRdmdCloudEligible`）。
//      这不是"敏感度较高"的问题，而是这类会话在契约上就不属于可外发范围。
//   2. **字段级**：`buildRdmdCloudPayload` 只挑白名单字段，其余一概不进。
//   3. **文本级**：节点文本（title/summary/output）会**原样**上传 —— 它们正是模型要读的
//      信号，没法删。所以第 1 条（哪些会话不许发）与能力位（要不要发）才是真正的边界；
//      本文件负责让"除了这几类文本之外还漏了什么"这件事**可复核**（见 `auditRdmdCloudPayload`）。
//
// 注意这里**不**复用 `sanitizeCollaborationPublicValue`：那个函数是给协作图做的
// "公开可见性"裁剪（去掉 prompt / 本地路径等），面向的是**同租户的其他用户**；
// 而这里面向的是**云运维方**，判据不同（协作图里可以有的 agentId，在这里也照发，
// 但整条 case 只允许出现在白名单里）。把两者混用会让"到底按谁的标准裁剪"变得说不清，
// 所以这条边界单独实现，并且有自己的测试。

/** 允许进入云侧载荷的节点字段。**加字段要在这里改，而不是在图里改。** */
export const RDMD_CLOUD_NODE_FIELDS = Object.freeze([
  'id', 'kind', 'title', 'agentId', 'version', 'acceptance',
  'artifact', 'stage', 'inputs', 'output', 'summary', 'status',
]);

/** 允许进入云侧载荷的边字段。 */
export const RDMD_CLOUD_EDGE_FIELDS = Object.freeze(['id', 'from', 'to', 'kind']);

/**
 * 允许出现在载荷顶层的字段。**就是 `planExecCase` 的形状**。
 *
 * 这里曾经写成 `['domain','title','nodes','edges']` —— 那是个真 bug，不是笔误：
 * 真实 case 是 `{id, G_star:{nodes,edges}, G_prime:{nodes,edges}}`，白名单里没有
 * `G_star`/`G_prime`，于是**每一条**载荷都被裁成空对象。它不报错、不抛异常，
 * 云侧正常入队、worker 正常领活，只是拿到的 case 里什么都没有。
 *
 * 之所以当初没被测试抓住：云侧的测试夹具照着这份白名单写（用 `nodes`/`edges`），
 * 于是"测试与 bug 相互印证"。修完这里，夹具也改成真实形状 —— 否则下一个读代码的人
 * 还会以为 `nodes`/`edges` 就是 case 的样子。判据在 predict.py：
 * 它只读 `case["G_star"]`、`case["G_prime"]`、`case.get("id")`。
 */
export const RDMD_CLOUD_CASE_FIELDS = Object.freeze(['id', 'G_star', 'G_prime']);

/** 两张图各自的字段。 */
export const RDMD_CLOUD_GRAPH_FIELDS = Object.freeze(['nodes', 'edges']);

/**
 * 在**入队之前**拒绝不该外发的会话。
 *
 * 与字段级裁剪分开，是因为这两件事的失败模式不同：字段级裁剪漏了一个字段，是"少发/多发
 * 一个属性"；会话级漏判，是"整段私有对话外发"。后者没有补救余地，所以它必须是**硬拒绝**，
 * 而不是"过滤掉再发"。
 */
export function assertRdmdCloudEligible({ privacy = {}, capabilityEnabled = false } = {}) {
  if (!capabilityEnabled) {
    const error = new Error('RDMD cloud inference capability is not enabled.');
    error.code = 'rdmd_cloud_capability_disabled';
    return { eligible: false, reason: 'capability_disabled' };
  }
  const conversationKind = text(privacy.conversationKind || privacy.conversation_kind);
  if (conversationKind === 'private_assistant') {
    return { eligible: false, reason: 'private_assistant_not_eligible' };
  }
  if (conversationKind && conversationKind !== 'collaboration') {
    // 未知的会话类型按不eligible处理。这条是**故意**的：以后新增一种会话类型时，
    // 默认落在"不外发"这一侧，而不是悄悄被放行。
    return { eligible: false, reason: `conversation_kind_unknown:${conversationKind}` };
  }
  return { eligible: true, reason: '' };
}

/**
 * 按白名单构造云侧载荷。**纯函数**（不碰网络、不碰 DB），所以可以被穷举测试。
 *
 * 与 `predict.py` 的入参契约保持一致：它要读的就是 `G_star`/`G_prime` 两张图。
 */
export function buildRdmdCloudPayload({ case: caseValue = {} } = {}) {
  const source = caseValue && typeof caseValue === 'object' ? caseValue : {};
  const payload = {};
  for (const field of RDMD_CLOUD_CASE_FIELDS) {
    if (!(field in source)) continue;
    if (field === 'id') {
      payload.id = text(source.id);
      continue;
    }
    // 图的**结构**也必须按白名单挑：`nodes`/`edges` 之外的东西（比如将来往图上挂的
    // 内部字段）一个都不发。
    const graph = source[field] && typeof source[field] === 'object' ? source[field] : {};
    payload[field] = {};
    for (const graphField of RDMD_CLOUD_GRAPH_FIELDS) {
      if (!(graphField in graph)) continue;
      payload[field][graphField] = graphField === 'nodes'
        ? array(graph.nodes).map(pickFields(RDMD_CLOUD_NODE_FIELDS))
        : array(graph.edges).map(pickFields(RDMD_CLOUD_EDGE_FIELDS));
    }
  }
  return payload;
}

/**
 * 复核"这份载荷里有没有白名单之外的东西"。
 *
 * 它的用途不是运行时拦截（`buildRdmdCloudPayload` 已经保证了结构），而是给测试与审计一条
 * **独立**的判据：读回真实落库的 `case_json`，枚举所有键路径，任何一个不在白名单里的键
 * 都算泄漏。这样"白名单真的生效了吗"可以被机器回答，而不是靠读代码确认。
 *
 * 判据按**路径形状**给，而不是按 `path.endsWith('.nodes')` 这类后缀猜：后缀匹配会让
 * `$.anything.nodes` 与 `$.G_star.nodes` 得到同一条规则，于是白名单的形状被悄悄放宽。
 */
export function auditRdmdCloudPayload(value, path = '$') {
  if (value == null || typeof value !== 'object') return [];
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...auditRdmdCloudPayload(item, `${path}[${index}]`)));
    return hits;
  }
  const allowed = allowedFieldsAtPath(path);
  for (const [key, raw] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (allowed && !allowed.includes(key)) {
      hits.push(`${childPath} (not in the whitelist for ${path})`);
      continue;
    }
    hits.push(...auditRdmdCloudPayload(raw, childPath));
  }
  return hits;
}

function allowedFieldsAtPath(path) {
  if (path === '$') return RDMD_CLOUD_CASE_FIELDS;
  if (/^\$\.(G_star|G_prime)$/.test(path)) return RDMD_CLOUD_GRAPH_FIELDS;
  if (/^\$\.(G_star|G_prime)\.nodes\[\d+\]$/.test(path)) return RDMD_CLOUD_NODE_FIELDS;
  if (/^\$\.(G_star|G_prime)\.edges\[\d+\]$/.test(path)) return RDMD_CLOUD_EDGE_FIELDS;
  // 未知形状：不给白名单，让调用方看到"这里没有规则"而不是悄悄放行。
  return null;
}

function pickFields(fields) {
  return (item) => {
    const result = {};
    for (const field of fields) {
      if (!(field in (item || {}))) continue;
      result[field] = text(item[field]);
    }
    return result;
  };
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  if (value == null) return '';
  return String(value);
}
