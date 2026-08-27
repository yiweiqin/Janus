import { BENCHMARK_VERSION, METHODS } from '../schema.mjs';

export const SPLITS = ['development', 'validation', 'locked_test', 'boundary'];

export function validateRunConfig(config) {
  const errors = [];
  if (config?.benchmark !== BENCHMARK_VERSION) errors.push('benchmark_version');
  if (!SPLITS.includes(config?.split)) errors.push('split');
  if (!Array.isArray(config?.methods) || !config.methods.length || config.methods.some((method) => !METHODS.includes(method))) errors.push('methods');
  if (!Array.isArray(config?.seeds) || !config.seeds.length || config.seeds.some((seed) => !Number.isInteger(seed))) errors.push('seeds');
  if (errors.length) throw new Error(`invalid_run_config:${errors.join(',')}`);
  return true;
}

export function assertFamilyDisjoint(splits) {
  const seen = new Map();
  for (const [split, tasks] of Object.entries(splits)) for (const task of tasks) {
    const prior = seen.get(task.taskFamily);
    if (prior && prior !== split) throw new Error(`task_family_leakage:${task.taskFamily}:${prior}:${split}`);
    seen.set(task.taskFamily, split);
  }
  return true;
}
