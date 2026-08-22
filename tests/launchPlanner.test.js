const assert = require('node:assert/strict');
const test = require('node:test');
const { planWaves } = require('../src/launch/planner');

test('planWaves keeps selection order within a priority tier and chunks by wave size', () => {
  const waves = planWaves({ wallets: ['a', 'b', 'c', 'd', 'e'], maxWaveSize: 2 });
  assert.deepEqual(waves.map(w => w.label), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(waves.map(w => w.wave), [0, 0, 1, 1, 2]);
});

test('planWaves sorts lower priority numbers to the front regardless of selection order', () => {
  const waves = planWaves({
    wallets: [{ label: 'late', priority: 100 }, { label: 'gtd-1', priority: 0 }, { label: 'gtd-2', priority: 0 }, { label: 'mid', priority: 50 }],
    maxWaveSize: 10,
  });
  assert.deepEqual(waves.map(w => w.label), ['gtd-1', 'gtd-2', 'mid', 'late']);
});

test('planWaves breaks priority ties by original selection order (stable)', () => {
  const waves = planWaves({
    wallets: [{ label: 'first', priority: 5 }, { label: 'second', priority: 5 }],
    maxWaveSize: 10,
  });
  assert.equal(waves[0].label, 'first');
  assert.equal(waves[1].label, 'second');
});

test('planWaves handles empty input and clamps non-positive wave sizes', () => {
  assert.deepEqual(planWaves({ wallets: [], maxWaveSize: 25 }), []);
  const waves = planWaves({ wallets: ['a', 'b'], maxWaveSize: 0 });
  assert.deepEqual(waves.map(w => w.wave), [0, 1], 'wave size clamps to at least one per wave');
});
