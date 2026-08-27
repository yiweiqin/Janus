export function createRng(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return {
    next() { state = (1664525 * state + 1013904223) >>> 0; return state / 0x100000000; },
    int(min, max) { return Math.floor(this.next() * (max - min + 1)) + min; },
    pick(items) { return items[Math.floor(this.next() * items.length)]; },
    shuffle(items) { const copy = [...items]; for (let i = copy.length - 1; i > 0; i -= 1) { const j = Math.floor(this.next() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; },
  };
}
