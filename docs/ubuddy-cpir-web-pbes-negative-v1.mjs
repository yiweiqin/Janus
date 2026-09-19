#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(fs.readFileSync(path.join(here, 'ubuddy-cpir-web-pbes-v1.input.example.json'), 'utf8'));
const checker = path.join(here, 'ubuddy-cpir-web-pbes-checker-v1.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cpir-web-pbes-v1-neg-'));
const clone = x => JSON.parse(JSON.stringify(x));
const out = [];
const run = (name, x, reason) => {
  const f = path.join(tmp, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify(x));
  const raw = spawnSync(process.execPath, [checker, f], {encoding: 'utf8'}).stdout;
  const result = JSON.parse(raw);
  out.push({name, expectedReasonCode: reason, actualReasonCode: result.reasonCode, passed: result.reasonCode === reason});
};

try {
  let x = clone(base);
  x.worldSetLockedBeforeSearch = false;
  run('unlocked-world-set', x, 'SCHEMA_VALIDATION_FAILED');

  x = clone(base);
  x.contractRegistryLockedBeforeSearch = false;
  run('unlocked-contract-registry', x, 'SCHEMA_VALIDATION_FAILED');

  x = clone(base);
  x.supportTableLockedBeforeSearch = false;
  run('unlocked-support-table', x, 'SCHEMA_VALIDATION_FAILED');

  x = clone(base);
  x.cases[0].worlds[1].publicObservation = 'DIFFERENT_PUBLIC_CUT';
  run('public-observation-mismatch', x, 'PAIRED_WORLD_PUBLIC_OBSERVATION_MISMATCH');

  x = clone(base);
  delete x.cases[0].probes[0].observationByWorld['w-receipt-lost'];
  run('probe-world-coverage-missing', x, 'PROBE_WORLD_COVERAGE_NOT_EXACT');

  x = clone(base);
  x.cases[0].probes[0].observationByWorld['w-extra'] = 'EXTRA';
  run('probe-world-coverage-extra', x, 'PROBE_WORLD_COVERAGE_NOT_EXACT');

  x = clone(base);
  delete x.cases[0].repairs[0].safeByWorld['w-receipt-lost'];
  run('repair-safety-coverage-missing', x, 'REPAIR_WORLD_COVERAGE_NOT_EXACT');

  x = clone(base);
  delete x.cases[0].repairs[0].utilityByWorld['w-receipt-lost'];
  run('repair-utility-coverage-missing', x, 'REPAIR_WORLD_COVERAGE_NOT_EXACT');

  x = clone(base);
  x.cases[0].worlds.push(clone(x.cases[0].worlds[0]));
  run('duplicate-world-id', x, 'DUPLICATE_ID');

  x = clone(base);
  x.cases[0].probes.push(clone(x.cases[0].probes[0]));
  run('duplicate-probe-id', x, 'DUPLICATE_ID');

  x = clone(base);
  x.cases[0].repairs.push(clone(x.cases[0].repairs[0]));
  run('duplicate-repair-id', x, 'DUPLICATE_ID');

  x = clone(base);
  x.cases[0].probes[0].irreversibleEffect = true;
  run('irreversible-probe', x, 'SCHEMA_VALIDATION_FAILED');
} finally {
  fs.rmSync(tmp, {recursive: true, force: true});
}

console.log(JSON.stringify({
  schemaVersion: 'cpir-web/pbes-negative/v1',
  implementationStatus: 'prototype/unverified',
  allPassed: out.every(x => x.passed),
  results: out
}, null, 2));
