// 这一层**已经搬到** `src/shared/contracts/uBuddyCapabilityDependencyScorer.js`，这里只剩转发。
//
// ## 为什么搬
//
// 前向传播的调用方是应用的规划路径（`selectCollaborators` / `selectReplacement` 一侧，
// 跑在 Electron 主进程里），而 `experiments/` 不进安装包。留在 experiments 里，
// 应用就没法 import 它 —— 而"应用 import 一个实验目录"本身也是「本地能跑、打包就崩」
// 的典型来源。
//
// ## 为什么留一个转发文件
//
// 训练侧的对账测试 `scorer.test.mjs` 从 `./scorer.mjs` 取 `buildScorer` /
// `scoreFeature`，直接改路径当然也行，但转发文件的代价是零，而它是「实现只有一份」
// 这条约束的可见凭证：读者在这个目录里找不到第二份前向传播，就不会有人去改错那一份。
//
// ## 别把这两个文件复制成两份
//
// 复制之后两份会因为一次改动而分叉，症状是「线上分数和离线指标对不上」，
// 排查起来极费时间 —— 详见 `src/shared/contracts/uBuddyCapabilityDependencyScorer.js`
// 文件头那段。

export * from '../../src/shared/contracts/uBuddyCapabilityDependencyScorer.js';
