export function whoWhenAdapter() {
  return { name: 'who_when', files: ['Algorithm-Generated.parquet', 'Hand-Crafted.parquet'], source: process.env.WHO_AND_WHEN_ROOT || 'benchmarks/who-and-when', role: 'optional_attribution_reference' };
}
