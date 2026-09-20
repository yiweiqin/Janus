// 发出去之前先自证完整：逐文件比对 BUNDLE.json 里的 sha256 / 字节数 / 行数，
// 并再验一次「test 的答案没有泄进包里」。
//
// 为什么值得单独跑一次：BUNDLE.json 存在的唯一意义就是让收件人能自己核对；
// 如果我们自己都不核，那它就只是装饰。而这个包会经手网盘/微信/邮箱，
// 中途被截断或转码都不会有人发现 —— 直到标注结果被判无效。
//
// 两个口径是踩出来的，别改成"看起来更直观"的写法：
//
//   1. 行数按 `\n` 的个数算（与 `export_bundle.mjs` 落 BUNDLE.json 时一致，
//      也是 `wc -l` 的口径）。按"非空行"算会少 20 行 —— 第一次跑就是这么误报的。
//   2. 泄题判据是「withheld 字段**带着非 null 的值**出现」，不是「字段名出现过」。
//      包里有两处合法的字段名：
//        - 卡片里的 `human: {annotatorId: null, rationale: null}` —— 那是留给
//          标注者填的空槽，null 不含任何信息；
//        - pair 行里的 `withheldFields: ["initDependency", ...]` —— 那是"哪些字段被
//          扣下了"的声明本身。
//      把"出现过名字"当泄题，会让这个闸对 7990 条误报，最后只能被加白名单加到失效。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || join(HERE, 'export', 'ai-judge-v1');

if (!existsSync(join(dir, 'BUNDLE.json'))) {
  console.error(`找不到 BUNDLE.json：${dir}`);
  process.exit(2);
}

const bundle = JSON.parse(readFileSync(join(dir, 'BUNDLE.json'), 'utf8'));
const problems = [];
let bytes = 0;

for (const expected of bundle.files) {
  const path = join(dir, expected.path);
  if (!existsSync(path)) {
    problems.push(`缺文件：${expected.path}`);
    continue;
  }
  const buffer = readFileSync(path);
  bytes += buffer.length;
  const digest = createHash('sha256').update(buffer).digest('hex');
  const lines = countLines(buffer);

  if (digest !== expected.sha256) problems.push(`sha256 不符：${expected.path}`);
  if (buffer.length !== expected.bytes) problems.push(`字节数不符：${expected.path} (${buffer.length} != ${expected.bytes})`);
  if (lines !== expected.lines) problems.push(`行数不符：${expected.path} (${lines} != ${expected.lines})`);
  console.log(`  ${digest === expected.sha256 ? 'ok  ' : 'BAD '} ${expected.path.padEnd(34)} ${String(buffer.length).padStart(9)} B  ${String(lines).padStart(6)} 行`);
}

/** 与 `wc -l` 同义：数 `\n` 的个数。 */
function countLines(buffer) {
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  return count;
}

/**
 * 收集一处 JSON 值里所有「带实际内容」的字段名。
 *
 * `null` / `undefined` 不算：它们是"这里有个槽，还没填"，不含信息。
 * 这正是卡片里 `human.annotatorId = null` 的情形。
 * `withheldFields` 那个数组也要跳过 —— 它列的就是被扣下的字段名，是声明不是数据。
 */
const DECLARATION_KEYS = new Set(['withheldFields']);
function contentBearingKeys(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) contentBearingKeys(item, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (DECLARATION_KEYS.has(key)) continue;
      if (inner !== null && inner !== undefined) {
        found.add(key);
        contentBearingKeys(inner, found);
      }
    }
  }
  return found;
}

const withheld = bundle.withheldFromBlind?.fields || [];
const testIds = new Set(
  readFileSync(join(dir, 'cards', 'test.blind.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).id),
);

let leaks = 0;
let testRowsSeen = 0;
for (const entry of bundle.files) {
  for (const line of readFileSync(join(dir, entry.path), 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line[0] !== '{') continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!testIds.has(row.id)) continue;
    testRowsSeen += 1;
    const present = contentBearingKeys(row);
    for (const field of withheld) {
      if (!present.has(field)) continue;
      leaks += 1;
      problems.push(`泄题：${entry.path} 里 test pair ${row.id} 带了有值的字段 ${field}`);
    }
  }
}

console.log();
console.log(`包目录：${dir}`);
console.log(`总计  ：${bundle.files.length} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`判分卡：test ${bundle.counts.testCards} + train/dev ${bundle.counts.trainDevCards} = ${bundle.counts.cards}`);
console.log(`泄题闸：${leaks === 0 ? `通过（检了 ${testRowsSeen} 条 test 行，${withheld.length} 个 withheld 字段都没有带值的出现）` : `${leaks} 处`}`);

if (problems.length) {
  console.error(`\n发现 ${problems.length} 个问题：`);
  for (const problem of problems.slice(0, 40)) console.error(`  - ${problem}`);
  if (problems.length > 40) console.error(`  …… 另有 ${problems.length - 40} 条`);
  process.exit(1);
}
console.log('\n全部一致：这个包可以发出去。');
