const test = require('node:test');
const assert = require('node:assert/strict');

test('adaptive money display never rounds a real tiny amount to zero', async () => {
  const { formatAdaptiveAmount, formatSignedAdaptiveAmount } = await import('../dashboard/src/amountDisplay.mjs');
  assert.equal(formatAdaptiveAmount(0), '0.000');
  assert.equal(formatAdaptiveAmount('0.4'), '0.400');
  assert.equal(formatAdaptiveAmount('0.0004007'), '0.000401');
  assert.equal(formatAdaptiveAmount('0.4', { minDecimals: 6 }), '0.400000');
  assert.equal(formatAdaptiveAmount('0.00004007', { minDecimals: 6 }), '0.0000401');
  assert.equal(formatAdaptiveAmount('0.0000004', { minDecimals: 6 }), '0.0000004');
  assert.equal(formatAdaptiveAmount('0.000000000000000001'), '0.000000000000000001');
  assert.equal(formatSignedAdaptiveAmount('-0.00004007'), '−0.0000401');
  assert.equal(formatAdaptiveAmount(null), '—');
  assert.equal(formatAdaptiveAmount('not-a-number', { fallback: 'unknown' }), 'unknown');
});
