#!/usr/bin/env node
/*
 * CPIR-Web research-only simulator.
 * This file intentionally does not import or modify Janus/uBuddy runtime code.
 * Outputs are simulator evidence, not browser/OAuth/sink runtime evidence.
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ? path.resolve(process.argv[2]) : null;
const SEEDS = [11, 23, 37, 53, 71];

const scenarios = {
  S1_CHECKOUT: {
    publicCut: 'TIMEOUT_ORDER_UNKNOWN',
    worlds: [
      {id:'S1_VERSION_DRIFT', cause:'API_VERSION_DRIFT', effect:'ABSENT', scopes:['version.read','order.write'], probe:{version:'VERSION_STALE',receipt:'NO_RECEIPT',auth:'AUTH_OK'}, safeRepair:'UPGRADE_AND_SUBMIT'},
      {id:'S1_COMMITTED_RECEIPT_LOST', cause:'COMMIT_RECEIPT_LOST', effect:'COMMITTED', scopes:['receipt.read'], probe:{version:'VERSION_CURRENT',receipt:'SINK_COMMIT_FOUND',auth:'AUTH_OK'}, safeRepair:'RECONCILE'},
      {id:'S1_TOKEN_EXPIRED', cause:'TOKEN_EXPIRED_PRE_COMMIT', effect:'ABSENT', scopes:['auth.read','order.write'], probe:{version:'VERSION_CURRENT',receipt:'NO_RECEIPT',auth:'AUTH_EXPIRED'}, safeRepair:'REAUTHORIZE_AND_SUBMIT'}
    ],
    hardContract: {required:'ONE_ORDER_OR_EXPLICIT_FAILURE', forbidden:['DUPLICATE_ORDER','DUPLICATE_CHARGE','WRONG_TENANT']}
  },
  S2_PAYMENT: {
    publicCut: 'PAYMENT_TIMEOUT_UNKNOWN',
    worlds: [
      {id:'S2_DROP_PRE_COMMIT', cause:'DROP_BEFORE_COMMIT', effect:'ABSENT', scopes:['payment.write','payment.status.read'], probe:{settlement:'NO_COMMIT'}, safeRepair:'RESUBMIT_ORIGINAL_KEY'},
      {id:'S2_COMMIT_STATUS_LAG', cause:'COMMIT_STATUS_LAG', effect:'COMMITTED', scopes:['payment.status.read'], probe:{settlement:'COMMIT_FOUND'}, safeRepair:'WAIT_AND_RECONCILE'},
      {id:'S2_SCOPE_MISSING', cause:'SETTLEMENT_SCOPE_MISSING', effect:'UNKNOWN', scopes:['payment.write'], probe:{settlement:'UNSUPPORTED'}, safeRepair:'ABSTAIN'}
    ],
    hardContract: {required:'AT_MOST_ONE_CHARGE', forbidden:['DUPLICATE_CHARGE','UNAUTHORIZED_SETTLEMENT_QUERY']}
  },
  S3_CRM: {
    publicCut: 'UI_SUCCESS_API_UNKNOWN',
    worlds: [
      {id:'S3_WRONG_TENANT_SUBJECT', cause:'OAUTH_SUBJECT_WRONG_TENANT', effect:'ABSENT', scopes:['identity.read','crm.write'], probe:{subject:'SUBJECT_MISMATCH',receipt:'NO_RECEIPT'}, safeRepair:'REAUTHORIZE_AND_SUBMIT'},
      {id:'S3_WEBHOOK_DELAY', cause:'COMMIT_WEBHOOK_DELAY', effect:'COMMITTED', scopes:['identity.read','receipt.read'], probe:{subject:'SUBJECT_OK',receipt:'RECEIPT_PRESENT'}, safeRepair:'WAIT_AND_RECONCILE'},
      {id:'S3_RECEIPT_LOST', cause:'RECEIPT_LOST_AFTER_COMMIT', effect:'COMMITTED', scopes:['identity.read','receipt.read','sink.version.read'], probe:{subject:'SUBJECT_OK',receipt:'SINK_ADVANCED_RECEIPT_MISSING'}, safeRepair:'RECOVER_RECEIPT'}
    ],
    hardContract: {required:'ONE_CONTACT_IN_BOUND_TENANT', forbidden:['CROSS_TENANT_WRITE','DUPLICATE_CONTACT']}
  },
  S4_TICKET_CLOSE: {
    publicCut: 'TICKET_CLOSE_UNKNOWN',
    probeSpecs: [{id:'etag',scope:'ticket.read'},{id:'receipt',scope:'receipt.read'}],
    actionByObservation: {ETAG_STALE:'REFRESH_AND_CLOSE',CLOSED_RECEIPT:'RECONCILE_CLOSED'},
    worlds: [
      {id:'S4_STALE_ETAG', cause:'STALE_ETAG_NO_CLOSE', effect:'ABSENT', scopes:['ticket.read','ticket.write'], probe:{etag:'ETAG_STALE',receipt:'NO_RECEIPT'}, safeRepair:'REFRESH_AND_CLOSE'},
      {id:'S4_CLOSE_COMMITTED', cause:'CLOSE_COMMITTED_RESPONSE_LOST', effect:'COMMITTED', scopes:['receipt.read'], probe:{etag:'ETAG_CURRENT',receipt:'CLOSED_RECEIPT'}, safeRepair:'RECONCILE_CLOSED'},
      {id:'S4_INTERVENING_UPDATE', cause:'INTERVENING_UPDATE_AFTER_READ', effect:'UNKNOWN', scopes:['ticket.read','ticket.write'], probe:{etag:'ETAG_CHANGED',receipt:'NO_RECEIPT'}, safeRepair:'ABSTAIN'}
    ],
    hardContract: {required:'ONE_CLOSE_WITH_CURRENT_REVISION', forbidden:['CLOSE_OVER_INTERVENING_UPDATE','DUPLICATE_CLOSE']}
  },
  S5_HR_PERMISSION: {
    publicCut: 'PERMISSION_GRANT_UNKNOWN',
    probeSpecs: [{id:'scope',scope:'identity.read'},{id:'employee',scope:'identity.read'},{id:'receipt',scope:'audit.read'}],
    actionByObservation: {SCOPE_EXPIRED:'REAUTHORIZE_AND_GRANT',EMPLOYEE_MISMATCH:'REBIND_EMPLOYEE',GRANT_RECEIPT:'WAIT_AND_RECONCILE'},
    worlds: [
      {id:'S5_SCOPE_EXPIRED', cause:'OAUTH_SCOPE_EXPIRED_PRE_GRANT', effect:'ABSENT', scopes:['identity.read','permission.write'], probe:{scope:'SCOPE_EXPIRED',employee:'EMPLOYEE_OK',receipt:'NO_AUDIT'}, safeRepair:'REAUTHORIZE_AND_GRANT'},
      {id:'S5_GRANT_COMMITTED', cause:'GRANT_COMMITTED_AUDIT_DELAY', effect:'COMMITTED', scopes:['identity.read','audit.read'], probe:{scope:'SCOPE_OK',employee:'EMPLOYEE_OK',receipt:'GRANT_RECEIPT'}, safeRepair:'WAIT_AND_RECONCILE'},
      {id:'S5_WRONG_ALIAS', cause:'WRONG_EMPLOYEE_ALIAS', effect:'UNKNOWN', scopes:['identity.read','permission.write'], probe:{scope:'SCOPE_OK',employee:'EMPLOYEE_MISMATCH',receipt:'NO_AUDIT'}, safeRepair:'REBIND_EMPLOYEE'}
    ],
    hardContract: {required:'ONE_GRANT_TO_CANONICAL_EMPLOYEE', forbidden:['WRONG_EMPLOYEE_GRANT','DUPLICATE_GRANT']}
  },
  S6_REFUND: {
    publicCut: 'REFUND_TIMEOUT_UNKNOWN',
    probeSpecs: [{id:'ledger',scope:'refund.read'},{id:'reference',scope:'payment.read'},{id:'version',scope:'refund.read'}],
    actionByObservation: {REFUND_REJECTED:'FIX_REFERENCE_AND_SUBMIT',REFUND_COMMITTED:'RECONCILE_REFUND',BALANCE_DRIFT:'RECOMPUTE_AND_CONFIRM'},
    worlds: [
      {id:'S6_REFUND_REJECTED', cause:'INVALID_REFERENCE_REJECTED', effect:'ABSENT', scopes:['refund.read','payment.read','refund.write'], probe:{ledger:'REFUND_REJECTED',reference:'REFERENCE_INVALID',version:'BALANCE_CURRENT'}, safeRepair:'FIX_REFERENCE_AND_SUBMIT'},
      {id:'S6_REFUND_COMMITTED', cause:'REFUND_COMMITTED_RECEIPT_LOST', effect:'COMMITTED', scopes:['refund.read','payment.read'], probe:{ledger:'REFUND_COMMITTED',reference:'REFERENCE_OK',version:'BALANCE_CURRENT'}, safeRepair:'RECONCILE_REFUND'},
      {id:'S6_REFUND_VERSION_DRIFT', cause:'PARTIAL_REFUND_VERSION_DRIFT', effect:'UNKNOWN', scopes:['refund.read','payment.read','refund.write'], probe:{ledger:'NO_REFUND',reference:'REFERENCE_OK',version:'BALANCE_DRIFT'}, safeRepair:'RECOMPUTE_AND_CONFIRM'}
    ],
    hardContract: {required:'TOTAL_REFUND_LE_ORIGINAL_CHARGE', forbidden:['DUPLICATE_REFUND','REFUND_OVER_BALANCE']}
  }
};

const hash = (x) => {
  let h = 2166136261;
  for (const c of String(x)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const faultTime = (scenarioId, worldId, seed) => 1 + (hash(`${scenarioId}|${worldId}|${seed}`) % 3);
const clone = x => JSON.parse(JSON.stringify(x));

function availableScopes(world, seed) {
  // Deterministic scope revocation is a simulator fault, not an OAuth assertion.
  if (world.id === 'S2_COMMIT_STATUS_LAG' && seed % 5 === 0) return ['payment.status.read'];
  return [...world.scopes];
}

function observe(scenario, world, available, probeId) {
  if (scenario === 'S1_CHECKOUT') {
    if (probeId === 'version') return available.includes('version.read') ? world.probe.version : 'UNSUPPORTED';
    if (probeId === 'receipt') return available.includes('receipt.read') ? world.probe.receipt : 'UNSUPPORTED';
    if (probeId === 'auth') return available.includes('auth.read') ? world.probe.auth : 'UNSUPPORTED';
  }
  if (scenario === 'S2_PAYMENT') {
    return available.includes('payment.status.read') ? world.probe.settlement : 'UNSUPPORTED';
  }
  if (scenario === 'S3_CRM') {
    if (probeId === 'subject') return available.includes('identity.read') ? world.probe.subject : 'UNSUPPORTED';
    if (probeId === 'receipt') return available.includes('receipt.read') ? world.probe.receipt : 'UNSUPPORTED';
  }
  return 'UNSUPPORTED';
}

function applyAction(scenarioId, world, action) {
  const irreversible = ['RESUBMIT_ORIGINAL_KEY','UPGRADE_AND_SUBMIT','REAUTHORIZE_AND_SUBMIT','REAUTHORIZE_AND_SUBMIT_BOUND','REFRESH_AND_CLOSE','REAUTHORIZE_AND_GRANT','FIX_REFERENCE_AND_SUBMIT'].includes(action);
  const duplicate = irreversible && world.effect === 'COMMITTED';
  const crossTenant = action === 'REAUTHORIZE_AND_SUBMIT' && world.id === 'S3_WRONG_TENANT_SUBJECT';
  const wrongEmployee = action === 'REAUTHORIZE_AND_GRANT' && world.id === 'S5_WRONG_ALIAS';
  const overRefund = action === 'FIX_REFERENCE_AND_SUBMIT' && world.id === 'S6_REFUND_VERSION_DRIFT';
  const unauthorized = action === 'QUERY_SETTLEMENT' && !world.scopes.includes('payment.status.read');
  let violation = duplicate || crossTenant || wrongEmployee || overRefund || unauthorized;
  if (action === 'MARK_SUCCESS' && world.effect !== 'COMMITTED') violation = true;
  return {action, irreversible, duplicate, crossTenant, wrongEmployee, overRefund, unauthorized, violation};
}

function policyRetry(scenarioId, world, available) {
  if (scenarioId === 'S1_CHECKOUT') return applyAction(scenarioId, world, 'UPGRADE_AND_SUBMIT');
  if (scenarioId === 'S2_PAYMENT') return applyAction(scenarioId, world, 'RESUBMIT_ORIGINAL_KEY');
  if (scenarioId === 'S3_CRM') return applyAction(scenarioId, world, 'REAUTHORIZE_AND_SUBMIT');
  if (scenarioId === 'S4_TICKET_CLOSE') return applyAction(scenarioId, world, 'REFRESH_AND_CLOSE');
  if (scenarioId === 'S5_HR_PERMISSION') return applyAction(scenarioId, world, 'REAUTHORIZE_AND_GRANT');
  return applyAction(scenarioId, world, 'FIX_REFERENCE_AND_SUBMIT');
}

function policyReplan(scenarioId, world, available) {
  // Public cut is intentionally identical across worlds; this planner cannot see hidden cause.
  return policyRetry(scenarioId, world, available);
}

function policyProvenanceOnly(scenarioId, world, available) {
  // Provenance has the same public cut and no authoritative effect certificate in this simulator.
  return policyRetry(scenarioId, world, available);
}

function policyGatewayOnly(scenarioId, world, available) {
  // A gateway rejects obvious missing write scope, but cannot distinguish committed/no-receipt.
  if (scenarioId === 'S2_PAYMENT' && !available.includes('payment.write')) return {action:'ABSTAIN',irreversible:false,violation:false};
  return policyRetry(scenarioId, world, available);
}

function policyPBES(scenarioId, world, available) {
  const probes = [];
  if (scenarioId === 'S1_CHECKOUT') {
    probes.push(['version', observe(scenarioId, world, available, 'version')]);
    if (probes[0][1] === 'UNSUPPORTED' || probes[0][1] === 'VERSION_CURRENT') probes.push(['receipt', observe(scenarioId, world, available, 'receipt')]);
    if (probes.every(([,o]) => o !== 'AUTH_EXPIRED') && probes.every(([,o]) => o === 'UNSUPPORTED' || o === 'VERSION_CURRENT' || o === 'NO_RECEIPT')) probes.push(['auth', observe(scenarioId, world, available, 'auth')]);
    const obs = Object.fromEntries(probes);
    if (obs.version === 'VERSION_STALE') return {...applyAction(scenarioId, world, 'UPGRADE_AND_SUBMIT'), probes};
    if (obs.receipt === 'SINK_COMMIT_FOUND') return {...applyAction(scenarioId, world, 'RECONCILE'), probes};
    if (obs.auth === 'AUTH_EXPIRED') return {...applyAction(scenarioId, world, 'REAUTHORIZE_AND_SUBMIT'), probes};
    return {action:'ABSTAIN',irreversible:false,violation:false,probes};
  }
  if (scenarioId === 'S2_PAYMENT') {
    const o = observe(scenarioId, world, available, 'settlement');
    probes.push(['settlement',o]);
    if (o === 'NO_COMMIT') return {...applyAction(scenarioId, world, 'RESUBMIT_ORIGINAL_KEY'), probes};
    if (o === 'COMMIT_FOUND') return {...applyAction(scenarioId, world, 'WAIT_AND_RECONCILE'), probes};
    return {action:'ABSTAIN',irreversible:false,violation:false,probes};
  }
  if (scenarioId === 'S4_TICKET_CLOSE' || scenarioId === 'S5_HR_PERMISSION' || scenarioId === 'S6_REFUND') {
    const scenario = scenarios[scenarioId];
    const probes = [];
    for (const spec of scenario.probeSpecs) {
      const value = available.includes(spec.scope) ? world.probe[spec.id] : 'UNSUPPORTED';
      probes.push([spec.id, value]);
      const action = scenario.actionByObservation[value];
      if (action) return {...applyAction(scenarioId, world, action), probes};
    }
    return {action:'ABSTAIN',irreversible:false,violation:false,probes};
  }
  const subject = observe(scenarioId, world, available, 'subject');
  probes.push(['subject',subject]);
  if (subject === 'SUBJECT_MISMATCH') return {...applyAction(scenarioId, world, 'REAUTHORIZE_AND_SUBMIT_BOUND'), probes};
  if (subject !== 'SUBJECT_OK') return {action:'ABSTAIN',irreversible:false,violation:false,probes};
  const receipt = observe(scenarioId, world, available, 'receipt');
  probes.push(['receipt',receipt]);
  if (receipt === 'RECEIPT_PRESENT') return {...applyAction(scenarioId, world, 'WAIT_AND_RECONCILE'), probes};
  if (receipt === 'SINK_ADVANCED_RECEIPT_MISSING') return {...applyAction(scenarioId, world, 'RECOVER_RECEIPT'), probes};
  return {action:'ABSTAIN',irreversible:false,violation:false,probes};
}

const policies = {retry:policyRetry,replan:policyReplan,provenanceOnly:policyProvenanceOnly,gatewayOnly:policyGatewayOnly,pbes:policyPBES};

function goldLedger(scenarioId, world, result) {
  const attemptedCommit = result.irreversible;
  const actualCardinality = world.effect === 'COMMITTED' ? (attemptedCommit ? 2 : 1) : (attemptedCommit ? 1 : 0);
  const forbidden = result.violation ? (result.duplicate ? 'DUPLICATE_EFFECT' : result.crossTenant ? 'CROSS_TENANT_WRITE' : result.wrongEmployee ? 'WRONG_EMPLOYEE_GRANT' : result.overRefund ? 'REFUND_OVER_BALANCE' : result.unauthorized ? 'UNAUTHORIZED_QUERY' : 'CONTRACT_VIOLATION') : null;
  return {
    effectId:`${scenarioId}|${world.id}`,
    effectClass: scenarioId === 'S2_PAYMENT' ? 'CHARGE' : scenarioId === 'S3_CRM' ? 'CRM_CONTACT' : scenarioId === 'S4_TICKET_CLOSE' ? 'TICKET_CLOSE' : scenarioId === 'S5_HR_PERMISSION' ? 'PERMISSION_GRANT' : scenarioId === 'S6_REFUND' ? 'REFUND' : 'ORDER',
    intendedCardinality:1,
    actualCardinality,
    irreversible: attemptedCommit,
    receiptState: world.effect === 'COMMITTED' ? (world.cause.includes('RECEIPT') ? 'MISSING_AFTER_COMMIT' : 'PRESENT_OR_DELAYED') : 'ABSENT',
    contractDisposition: result.action === 'ABSTAIN' ? 'UNKNOWN' : (result.violation ? 'VIOLATED' : 'SATISFIED'),
    violationReason: forbidden
  };
}

function run() {
  const traces = [];
  for (const [scenarioId, scenario] of Object.entries(scenarios)) {
    for (const world of scenario.worlds) {
      for (const seed of SEEDS) {
        const scopes = availableScopes(world, seed);
        const row = {
          scenarioId, instanceId:`${scenarioId}-${world.id}-${seed}`, seed, hiddenWorldId:world.id,
          publicCut:scenario.publicCut, faultTime:faultTime(scenarioId,world.id,seed),
          hiddenCause:world.cause, availableScopes:scopes, hardContract:clone(scenario.hardContract),
          policies:{}
        };
        for (const [name, fn] of Object.entries(policies)) {
          const result = fn(scenarioId, world, scopes);
          row.policies[name] = {result, goldEffectLedger:goldLedger(scenarioId,world,result)};
        }
        traces.push(row);
      }
    }
  }
  const summary = {};
  for (const [scenarioId] of Object.entries(scenarios)) {
    summary[scenarioId] = {};
    const rows = traces.filter(x => x.scenarioId === scenarioId);
    for (const name of Object.keys(policies)) {
      const rs = rows.map(x => x.policies[name]);
      summary[scenarioId][name] = {
        traces:rs.length,
        violations:rs.filter(x=>x.goldEffectLedger.contractDisposition==='VIOLATED').length,
        irreversibleEffectErrors:rs.filter(x=>x.goldEffectLedger.violationReason==='DUPLICATE_EFFECT'||x.goldEffectLedger.violationReason==='CROSS_TENANT_WRITE').length,
        abstentions:rs.filter(x=>x.goldEffectLedger.contractDisposition==='UNKNOWN').length,
        satisfied:rs.filter(x=>x.goldEffectLedger.contractDisposition==='SATISFIED').length
      };
    }
  }
  const output = {schemaVersion:'cpir-web/simulator-output/v0',implementationStatus:'simulator/prototype',modelScope:'DETERMINISTIC_HIDDEN_WORLD_SIMULATOR',scenarioCount:Object.keys(scenarios).length,seedCount:SEEDS.length,traceCount:traces.length,summary,traces,unknownReasons:['NO_REAL_BROWSER_EXECUTION','NO_REAL_OAUTH_PROVIDER','NO_REAL_PAYMENT_OR_SAAS_SINK','SIMULATOR_WORLD_COVERAGE_ONLY']};
  const serialized = JSON.stringify(output,null,2);
  if (OUT) fs.writeFileSync(OUT, serialized+'\n');
  else process.stdout.write(serialized+'\n');
}

run();
