import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDecisionSufficiency } from '../../src/shared/contracts/uBuddyDecisionSufficiency.js';

const base = (worlds, actions=['a','b'], epsilon=0) => assessDecisionSufficiency({
  worlds, allowedActions: actions, query: 'q', epsilon,
  coverage: { complete: true, basisRef: 'basis' }
});

const safe = { a: true, b: true, c: true };

test('interval mode rejects point certificate via upper-best minus lower-candidate', () => {
  const worlds = [{ id:'w', support:true, safe, utility:{ a: 0.8, b: 0.9 }, utilityInterval:{ a:{lower:0.1,upper:0.8}, b:{lower:0.9,upper:0.9} } }];
  const point = base([{ id:'w', support:true, safe, utility:{ a:0.8, b:0.9 } }], ['a','b'], 0.2);
  const interval = base(worlds, ['a','b'], 0.2);
  assert.equal(point.status, 'CERTIFIED');
  assert.equal(interval.status, 'CERTIFIED');
  assert.equal(interval.action, 'b');
  assert.equal(interval.regretBound, 0);
});

test('interval bounds must be finite, ordered, and present for every action', () => {
  for (const utilityInterval of [
    { a:{lower:1,upper:0}, b:{lower:0,upper:0} },
    { a:{lower:0,upper:Infinity}, b:{lower:0,upper:0} },
    { a:{lower:0,upper:1} },
  ]) {
    const out = base([{ id:'w', support:true, safe, utilityInterval }]);
    assert.equal(out.status, 'UNKNOWN');
    assert.equal(out.reason, 'utility_interval_incomplete');
  }
});

test('epsilon boundary is inclusive and unsafe high-upper action is excluded', () => {
  const worlds = [
    { id:'w1', support:true, safe, utilityInterval:{ a:{lower:0.8,upper:0.8}, b:{lower:1,upper:1} } },
    { id:'w2', support:true, safe:{a:true,b:false}, utilityInterval:{ a:{lower:0.8,upper:0.8}, b:{lower:100,upper:100} } },
  ];
  const out = base(worlds, ['a','b'], 0.2);
  assert.equal(out.status, 'CERTIFIED');
  assert.equal(out.action, 'a');
  assert.ok(Math.abs(out.regretBound - 0.2) < 1e-12);
});

test('interval ties break deterministically by action name', () => {
  const out = base([{ id:'w', support:true, safe, utilityInterval:{ a:{lower:0,upper:1}, b:{lower:0,upper:1} } }], ['b','a'], 1);
  assert.equal(out.status, 'CERTIFIED');
  assert.equal(out.action, 'a');
});

test('interval solver matches brute-force oracle on a deterministic catalog', () => {
  const worlds = [
    { id:'w1', support:true, safe:{a:true,b:true,c:false}, utilityInterval:{ a:{lower:0.2,upper:0.5}, b:{lower:0.1,upper:0.4}, c:{lower:0.3,upper:0.3} } },
    { id:'w2', support:true, safe:{a:true,b:true,c:false}, utilityInterval:{ a:{lower:0.4,upper:0.6}, b:{lower:0.2,upper:0.7}, c:{lower:1,upper:1} } },
  ];
  const actions = ['a','b','c']; const epsilon = 0.5;
  const out = base(worlds, actions, epsilon);
  const oracle = actions.map(action => {
    let worst = -Infinity;
    for (const w of worlds) {
      if (!w.safe[action]) { worst = Infinity; break; }
      const bestUpper = Math.max(...actions.filter(a => w.safe[a]).map(a => w.utilityInterval[a].upper));
      worst = Math.max(worst, bestUpper - w.utilityInterval[action].lower);
    }
    return { action, worst };
  }).filter(x => Number.isFinite(x.worst) && x.worst <= epsilon).sort((x,y) => x.worst-y.worst || x.action.localeCompare(y.action));
  assert.equal(out.status, oracle.length ? 'CERTIFIED' : 'UNKNOWN');
  if (oracle.length) { assert.equal(out.action, oracle[0].action); assert.ok(Math.abs(out.regretBound - oracle[0].worst) < 1e-12); }
});




