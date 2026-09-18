// RDMD 推理后端：可插拔，**默认是空后端**。
//
// 为什么默认必须是空后端而不是"没有后端"：整条产品链路（桌面端提交 → 云侧作业 → 判定回传
// → record_only 记录）必须能在**没有 GPU** 的环境里建起来、跑得通、测得动。
// 如果"没配 GPU"表现为"链路上某个端点 500"，那么这条链路的正确性就只能等 GPU 到位才能验，
// 而那时要同时排查"链路写错了"和"模型不对"两件事。
//
// 所以两个后端都能**独立地把流程走完**，区别只在判定从哪来：
//
//   null       —— 立即判 UNKNOWN + reason=model_not_configured。作业终态是 `unavailable`。
//                 这不是错误状态，是"本部署没有推理能力"的正常表达。
//   gpu_worker —— 作业留在队列里，等 GPU 盒出站来 claim；判定由 worker 回传。
//
// 关键约束：**空后端不许假装有答案**。它返回的 UNKNOWN 走的是与真实 UNKNOWN 完全相同的
// 字段形状（含 reason），这样桌面端不需要为"没有模型"写一条特殊分支 —— 那条分支必然会
// 与真实的 UNKNOWN 处理逻辑分叉，然后其中一条烂掉。

export const RDMD_BACKENDS = Object.freeze(['null', 'gpu_worker']);

/** 空后端对任何 case 的判定。**不读 case 内容** —— 没有模型就没有任何信息可用。 */
export function nullBackendVerdict({ contractVersion = '', ruleVersion = '' } = {}) {
  return {
    status: 'UNKNOWN',
    nodeId: '',
    type: '',
    reason: 'model_not_configured',
    valid: true,
    warnings: [],
    provenance: {
      adapterSha256: '',
      baseModelId: '',
      contractVersion: string(contractVersion),
      ruleVersion: string(ruleVersion),
      workerVersion: 'cloud-null-backend',
    },
  };
}

/**
 * 解析部署配的后端。
 *
 * 未知取值 → `null`（而不是抛错）。理由与上面同源：配置写错时的正确行为是"这一轮不产出动作"
 * 并留下原因，而不是让云 API 起不来 —— RDMD 是辅助能力，没有资格把主服务拖下水。
 * 写错这件事不会静默：`resolveRdmdBackend` 同时返回 `warning`，路由把它记进作业的 error_text。
 */
export function resolveRdmdBackend(value) {
  const name = string(value || 'null').trim().toLowerCase();
  if (RDMD_BACKENDS.includes(name)) return { name, warning: '' };
  return { name: 'null', warning: `unknown_backend:${name}` };
}

/**
 * 作业提交后，后端是否**立刻**给得出判定。
 *
 * `null` 后端给得出（因此提交调用可以同步返回判定，桌面端不必轮询）；
 * `gpu_worker` 给不出（必须排队，桌面端按 deadline 轮询）。
 */
export function backendResolvesImmediately(backend) {
  return backend === 'null';
}

function string(value) {
  return value == null ? '' : String(value);
}
