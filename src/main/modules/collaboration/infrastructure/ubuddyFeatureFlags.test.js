/**
 * 动作侧能力位的默认值测试。
 *
 * 为什么这几行值得单独一个文件：P5 的全部安全性都压在"默认关闭"这一件事上。
 * `resolve()` 对**不在** `SAFE_DEFAULT_OFF` 里的 flag 是**默认开**的（见 `DEFAULT_ON_BY_DEFAULT`
 * 与 `normalizePolicy(configured.value, DEFAULT_ON_BY_DEFAULT.has(flag))`），也就是说
 * 把 `planExecDriftApply` 从那个集合里删掉，不会报错、不会红——它只会让动作侧**静默变成开**。
 * 影子测试注入的是假 `featureFlags`，看不见这种回归；只有这里能。
 *
 * 运行：node --test src/main/modules/collaboration/infrastructure/ubuddyFeatureFlags.test.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../../../db.js';
import { Store } from '../../../store.js';
import { createUBuddyFeatureFlagService, UBUDDY_FEATURE_FLAGS } from './ubuddyFeatureFlags.js';

async function fixture({ env = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'janus-flag-drift-'));
  const db = openDatabase(root, { skipMigrationBackup: true });
  const store = new Store(db, { root });
  return {
    store,
    flags: createUBuddyFeatureFlagService({ store, env }),
    cleanup: async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

test('动作侧能力位的名字就是文档与查询里写的那个', () => {
  assert.equal(UBUDDY_FEATURE_FLAGS.planExecDriftApply, 'ubuddy_plan_exec_drift_apply');
});

test('默认关闭：没有任何配置时 apply 必须是 off，且来源是 default', async (t) => {
  const { flags, cleanup } = await fixture();
  t.after(cleanup);

  const snapshot = flags.snapshot({ userId: 'u1' });
  assert.equal(snapshot.planExecDriftApply, false, '开了它就等于允许动作侧改产品，默认必须是关的');
  // 诊断侧默认开着：能力位是"在诊断之上多留证据"，不是另一个独立功能。
  assert.equal(snapshot.planExecDrift, true);
  assert.equal(flags.resolve(UBUDDY_FEATURE_FLAGS.planExecDriftApply, {}).source, 'default');
});

test('环境变量可以显式打开它 —— 但只能显式', async (t) => {
  const { flags, cleanup } = await fixture({ env: { JANUS_UBUDDY_PLAN_EXEC_DRIFT_APPLY: '1' } });
  t.after(cleanup);

  const resolved = flags.resolve(UBUDDY_FEATURE_FLAGS.planExecDriftApply, {});
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.source, 'environment', '来源必须是环境变量，不是"碰巧默认开"');
  assert.equal(flags.snapshot({ userId: 'u1' }).planExecDriftApply, true);
});
