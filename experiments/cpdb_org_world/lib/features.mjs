// 这一层**已经搬到** `src/shared/contracts/uBuddyCapabilityPairFeatures.js`，这里只剩转发。
//
// ## 为什么搬
//
// 特征、权重加载、前向传播原本都长在这个目录下，因为它们是训练生产出来的。但调用方是
// **应用的规划路径**（`selectCollaborators` / `selectReplacement` 一侧，跑在 Electron
// 主进程里），而 `experiments/` 不进安装包 —— 应用去 import 一个不在包里的目录，
// 属于「本地能跑、打包就崩」。
//
// ## 为什么留一个转发文件，而不是把 import 全改掉
//
// `export *` 一个转发文件是最省事、也最不容易改错的做法：训练侧的
// `export_training_matrix.mjs`、`features.test.mjs`、`scorer.mjs` 全都不用动，
// 而实现仍然只有一份。**关键是不要为了"看起来干净"把文件复制成两份** ——
// 复制之后两份会因为一次改动而分叉，而分叉的症状是「线上分数和离线指标对不上」，
// 排查起来极费时间（详见 `src/shared/contracts/uBuddyCapabilityPairFeatures.js` 的文件头）。

export * from '../../../src/shared/contracts/uBuddyCapabilityPairFeatures.js';
