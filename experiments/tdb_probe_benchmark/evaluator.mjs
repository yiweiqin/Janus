// Independent acceptance rule. Never receives the injected fault or action.
export const EVALUATOR_VERSION = 'invoice-exact-cents-v1';
export function evaluate(specification, output) {
  const subtotal = specification.currentRows.reduce((n, r) => n + r.quantity * r.unitCents, 0);
  const expected = subtotal + Math.floor((subtotal * specification.taxPercent + 50) / 100);
  return {
    success: Number.isSafeInteger(output.totalCents) && output.totalCents === expected,
    utility: output.totalCents === expected ? 1 : 0,
    expectedTotalCents: expected,
    actualTotalCents: output.totalCents,
    evaluatorVersion: EVALUATOR_VERSION,
  };
}
