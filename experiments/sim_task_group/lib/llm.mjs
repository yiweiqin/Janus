/**
 * 模拟任务群的模型客户端。
 *
 * ## 这一层只做三件事，传输一行都不重写
 *
 * 真正的 fetch / 重试 / 超时 / JSON 兜底在
 * `experiments/rdmd_detective_dataset/lib/llmClient.mjs`（语料那边已经在用）。
 * 两份传输实现会演化成两条重试策略、两个超时口径，迟早不一致。所以这里只加：
 *
 *   1. **模型名解析**：仓库统一用 `OPENAI_MODEL`（`scripts/ubuddy_experiment.mjs#doctor`
 *      的判据就是这个），而 `llmModel()` 不认识它。这里补上，并让 `SIM_GROUP_MODEL`
 *      可以单独覆盖（不动 rdmd 语料的行为）。
 *   2. **`doctor()`**：把"能不能跑模型"讲清楚，且**不回显密钥**。
 *   3. **`assertKeyNotPersisted()`**：见下。
 *
 * ## 密钥只在运行时经 env 注入
 *
 * 盒子上的实测结论是：**环境里没有任何模型密钥**（`env` 与云 API 的
 * `/proc/<pid>/environ` 都没有）。所以密钥必须由调用方在**运行时**注入，且
 * - 不写任何文件、
 * - 不进 artifact（`generated.jsonl` / 报告 / bundle）、
 * - 不进日志。
 *
 * 「不写文件」这件事靠自觉是靠不住的 —— 这个库里所有产物都要写到磁盘。
 * 所以 `assertKeyNotPersisted(text)` 是一个**可以在写盘前调用**的断言：
 * 它拿当前密钥去扫将要写出的字符串。`simulate.mjs` 在每次写盘前都调它。
 * 这样"密钥漏进 artifact"这件事会变成一次崩溃，而不是一个安静的泄密。
 *
 * ## 没有密钥时不许装作能跑
 *
 * `doctor()` 返回 `configured: false` 时，`simulate.mjs` **必须**退回
 * `--mode offline`（走语料的本地 teacher，零模型调用），而不是产出空样本再报"成功"。
 * 盒子上默认就是这个状态。
 */
import { llmJson as transportJson } from '../../rdmd_detective_dataset/lib/llmClient.mjs';

/** 模型名解析。`SIM_GROUP_MODEL` → 仓库统一的 `OPENAI_MODEL` → rdmd 语料那串回退。 */
export function simModel() {
  return String(
    process.env.SIM_GROUP_MODEL
    || process.env.OPENAI_MODEL
    || process.env.RDMD_MODEL
    || process.env.UBUDDY_ORGBENCH_MODEL
    || process.env.UBUDDY_APPWORLD_MODEL
    || 'gpt-5.5',
  );
}

/** 端点与密钥的存在性（`doctor` 的判据，沿用 `scripts/ubuddy_experiment.mjs:71-73`）。 */
export function modelCredentials() {
  const baseUrl = String(process.env.OPENAI_BASE_URL || '').trim();
  const key = String(process.env.CRS_OAI_KEY || process.env.OPENAI_API_KEY || '').trim();
  return { baseUrl, key, configured: Boolean(baseUrl && key) };
}

/**
 * 沙盒内的自检结果。**刻意不回显 key 本身**，连长度与前缀都不给 ——
 * 一段"sk-…长度 51"的日志在共享终端里就是一条可被搜索的线索。
 */
export function doctor() {
  const { baseUrl, key, configured } = modelCredentials();
  return {
    tool: 'sim-task-group',
    configured,
    model: simModel(),
    baseUrl: baseUrl || '',
    // 只报"有/没有"，不报内容。
    keySource: process.env.CRS_OAI_KEY ? 'CRS_OAI_KEY' : (process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : ''),
    hasKey: Boolean(key),
    note: '密钥只在运行时经 env 注入：不落盘、不进 artifact。没有密钥时用 --mode offline。',
  };
}

/**
 * 写盘前的最后一道闸：**即将写出的文本里不许出现当前密钥**。
 *
 * 为什么值得一个专门的函数：这个脚本的产物（`generated.jsonl`、报告、上传 bundle）
 * 都会被 git 跟踪/上传到盒子。一次"把 env 整个 dump 进报告方便调试"就够泄一次。
 * 崩溃比泄密便宜得多。
 */
export function assertKeyNotPersisted(text, where = 'artifact') {
  const { key } = modelCredentials();
  if (!key) return;
  if (String(text).includes(key)) {
    throw new Error(`sim_key_leaked_into_${where}: 模型密钥出现在即将写出的内容里，已中止写盘`);
  }
}

/**
 * 带缓存的一次模型调用。
 *
 * 缓存按 `(stage, model, prompt)` 的 sha256 存，因此**同输入同结果**：
 * 重跑一轮不会重复付费，也不会因为模型抖动让两次报告不可比。
 *
 * `cache` 传 `null` 就跳过缓存（评测要新鲜样本时用）。
 */
export async function simJson({ system, user, stage = 'sim', cache = null, temperature = 0.4, timeoutMs = 180000, retries = 3 } = {}) {
  const { configured } = modelCredentials();
  if (!configured) throw new Error('model_endpoint_not_configured');
  const { createHash } = await import('node:crypto');
  const model = simModel();
  const key = createHash('sha256').update(`${stage}\u0000${model}\u0000${system}\u0000${user}`).digest('hex');
  if (cache) {
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true };
  }
  const result = await transportJson({ system, user, stage, model, temperature, timeoutMs, retries });
  const value = { value: result.value, model: result.model, responseHash: result.responseHash, cached: false };
  if (cache) cache.set(key, { ...value, cached: true });
  return value;
}

/** 内存缓存。落盘的缓存没必要 —— 一次跑就是一次会话，跨机复用反而会让报告对不上模型版本。 */
export function memoryCache() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
    get size() { return map.size; },
  };
}
