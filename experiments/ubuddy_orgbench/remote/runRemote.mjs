#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') throw new Error('remote_runner_refuses_windows_use_remote_ubuntu');
if (process.env.UBUDDY_ORGBENCH_REMOTE !== '1') throw new Error('set_UBUDDY_ORGBENCH_REMOTE=1');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const configFile = path.resolve(process.argv[2] || path.join(root, 'experiments/ubuddy_orgbench/benchmark.config.example.json'));
const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
if (config.benchmark !== 'ubuddy_orgbench_v2') throw new Error('benchmark_config_version_mismatch');
const outputDir = path.resolve(process.env.UBUDDY_ORGBENCH_OUTPUT_ROOT || config.outputDir);
await fs.mkdir(outputDir, { recursive: true });
const args = [path.join(root, 'experiments/ubuddy_orgbench/orgbench_experiment.mjs'), 'main', '--real-appworld', '--run-dir', outputDir, '--split', config.split, '--methods', config.methods.join(','), '--seeds', config.seeds.join(',')];
if (config.taskIds?.length) args.push('--task-count', String(config.taskIds.length));
const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
process.exitCode = code;
