// 云侧 RDMD 用到的契约常量。**全部从桌面端同一份定义再导出**，不在这里另立一份。
//
// 为什么必须再导出而不是复制：云侧与桌面端对"什么算合法判定"的判断必须逐字一致。
// 一旦云侧自己写一份 drift type 列表，它就会在某一版之后开始与桌面端分叉 ——
// 云侧放行的 type 桌面端不认识（`routeEvolution` 兜底成 minimal_plan_edit），
// 或者反过来云侧拦掉一个合法 type。这类分叉不会报错，只会安静地降低准确率。
// 所以这里只允许 re-export，不允许出现新的字面量列表。

export { RDMD_DRIFT_TYPES, UBUDDY_RDMD_VERSION } from '../../../../src/shared/contracts/uBuddyReverseDetective.js';
export { PLAN_EXEC_CONTRACT_VERSION } from '../../../../src/shared/contracts/uBuddyPlanExec.js';

/**
 * 判定允许的 status。与训练语料的 `label.status` 取值域一一对应（drift / no_drift / UNKNOWN）。
 *
 * 这是**唯一**允许在云侧新写的枚举，因为它是云侧作业表的状态机取值，桌面端没有对应物。
 * 它与语料的对齐由测试保证（`cloud/test/rdmd-inference-jobs.test.mjs`），不是靠注释。
 */
export const RDMD_CLOUD_VERDICT_STATUSES = Object.freeze(['drift', 'no_drift', 'UNKNOWN']);

/**
 * 云侧这一层自己的规则版本（作业状态机 + 出处校验规则的版本）。
 *
 * 与 `PLAN_EXEC_CONTRACT_VERSION`（输入形状的契约）刻意分开：契约版本描述"模型看到什么"，
 * 规则版本描述"云侧怎么收/怎么判"。两者会独立演进 —— 比如契约不变，但出处校验从
 * "非空即可"收紧成"必须是 64 位 hex"，那是规则版本变了。
 */
export const RDMD_RULE_VERSION = 'rdmd_cloud_jobs_v1';
