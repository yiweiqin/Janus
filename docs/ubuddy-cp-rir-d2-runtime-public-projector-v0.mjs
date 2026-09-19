#!/usr/bin/env node
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const checker=fileURLToPath(new URL('./ubuddy-cp-rir-d2-runtime-sink-transcript-checker-v0.mjs',import.meta.url));const args=process.argv[2]?[process.argv[2]]:[];const r=spawnSync(process.execPath,[checker,...args],{encoding:'utf8'});let audit;try{audit=JSON.parse(r.stdout);}catch{audit={status:'INPUT_INVALID'};}const code=audit.status==='INPUT_INVALID'?'CATALOG_INVALID':'UNKNOWN________';
console.log(JSON.stringify({schemaVersion:'cp-rir/d2-runtime-public-output/v0',implementationStatus:'prototype/unverified',channel:'PUBLIC_PROJECTION',statusCode:code,decision:'ABSTAIN',padding:'0000000000000000',limitations:'NO_FIXED_LATENCY_OR_PROCESS_ISOLATION'}));
