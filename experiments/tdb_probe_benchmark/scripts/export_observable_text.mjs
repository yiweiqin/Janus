import fs from 'node:fs/promises';
const [input, output] = process.argv.slice(2);
const rows = (await fs.readFile(input, 'utf8')).trim().split('\n').map(JSON.parse);
const text = rows.map(r => JSON.stringify({ id: r.id, features: r.features }, null, 0)).join('\n') + '\n';
await fs.writeFile(output, text, { flag: 'w' });
console.log(JSON.stringify({ rows: rows.length, output }));
