export function makeRng(seed = 1) {
  let state = Math.abs(Number(seed) || 1) % 2147483647;
  if (state === 0) state = 1;
  const next = () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
  return {
    next,
    int(max) { return Math.floor(next() * Math.max(1, max)); },
    pick(list) { return list[this.int(list.length)]; },
    bool(p = 0.5) { return next() < p; },
    shuffle(list) {
      const copy = [...list];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = this.int(i + 1);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
    sample(list, k) {
      return this.shuffle(list).slice(0, Math.max(0, Math.min(k, list.length)));
    },
  };
}

export function splitForOrg(orgId, ratio = { train: 0.8, development: 0.1, test: 0.1 }) {
  let hash = 0;
  for (const char of String(orgId)) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  const unit = (hash % 1000) / 1000;
  if (unit < ratio.train) return 'train';
  if (unit < ratio.train + ratio.development) return 'development';
  return 'test';
}

export function quantizeScore(value) {
  const number = Math.min(1, Math.max(0, Number(value) || 0));
  const steps = [0, 0.25, 0.5, 0.75, 1];
  return steps.reduce((best, step) => (Math.abs(step - number) < Math.abs(best - number) ? step : best), 0);
}
