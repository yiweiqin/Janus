// Is the collaboration-graph code in the *installed* desktop build?
//
// If the repo has it but the installed app.asar does not, then the tables can never
// appear locally no matter how many tasks the user runs -- that is a release gap,
// not a data or design problem, and no amount of probe work will fix it.
//
// Searches app.asar bytes directly for the distinguishing strings.
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATE_ROOTS = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs'),
  path.join(process.env.LOCALAPPDATA || ''),
  'C:\\Program Files',
];

const NEEDLES = [
  'ensureUBuddyCollaborationGraphSchema',
  'collaboration_graph_nodes',
  'collaborationGraphStoreMethods',
  // 对照：这个迁移**确实**在活库里被记录过，所以它必须在旧构建里存在。
  // 如果连它都找不到，说明我的搜索路径错了，而不是"新代码没发布"。
  'ensureUBuddyCoordinationContractV2',
];

function findAsars(root, depth = 0, found = []) {
  if (depth > 4 || !root) return found;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    try {
      if (entry.isFile() && entry.name === 'app.asar') found.push(full);
      else if (entry.isDirectory()) findAsars(full, depth + 1, found);
    } catch { /* unreadable dir */ }
  }
  return found;
}

const asars = [];
for (const root of CANDIDATE_ROOTS) findAsars(root, 0, asars);

console.log(`=== app.asar found: ${asars.length} ===`);
for (const a of asars) {
  const stat = fs.statSync(a);
  console.log(`\n  ${a}`);
  console.log(`  size=${stat.size}  mtime=${stat.mtime.toISOString()}`);
  const bytes = fs.readFileSync(a);
  for (const needle of NEEDLES) {
    const present = bytes.includes(Buffer.from(needle, 'utf8'));
    console.log(`    ${present ? 'PRESENT' : 'ABSENT '}  ${needle}`);
  }
  // 版本号：asar 里的 package.json 是明文分片，直接找 version 字段附近的字节。
  const m = bytes.toString('latin1').match(/"version"\s*:\s*"(\d+\.\d+\.\d+[^"]*)"/);
  console.log(`    version-ish: ${m ? m[1] : '(not found)'}`);
}
