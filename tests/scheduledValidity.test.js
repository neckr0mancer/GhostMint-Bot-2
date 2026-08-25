const assert = require('node:assert/strict');
const test = require('node:test');
const { classifySeaDropWindow, preArmRearm } = require('../src/scheduler/scheduledValidity');

const T = Date.parse('2026-08-28T15:00:00.000Z');
const drop = (startSec, endSec) => ({ startTime: startSec, endTime: endSec, mintPriceWei: '0', maxTotalMintableByWallet: 1 });

test('no PublicDrop data means no-data: fire as scheduled, never invent a window', () => {
  for (const empty of [null, undefined, {}, { startTime: 'NaN' }]) {
    const c = classifySeaDropWindow(empty, T);
    assert.equal(c.phase, 'no-data');
    assert.equal(preArmRearm(c, T, 24 * 3600_000), null);
  }
});

test('early: now before startTime (the T vs T+5s competitive case)', () => {
  const c = classifySeaDropWindow(drop(T / 1000 + 5), T);
  assert.equal(c.phase, 'early');
  assert.equal(c.startTimeMs, T + 5000);
  const move = preArmRearm(c, T, 24 * 3600_000);
  assert.equal(move.fireAtMs, T + 5000);
  assert.match(move.reason, /5s after the scheduled time/);
});

test('the second-floor matches the drift preflight: a task at T+0.9s is NOT early', () => {
  // startTime = T (seconds). now = T + 900ms -> floor(nowSec) === startTime -> open, not early.
  const c = classifySeaDropWindow(drop(T / 1000), T + 900);
  assert.equal(c.phase, 'open');
  assert.equal(preArmRearm(c, T, 24 * 3600_000), null);
});

test('open: inside the window fires immediately', () => {
  const c = classifySeaDropWindow(drop(T / 1000 - 60, T / 1000 + 3600), T);
  assert.equal(c.phase, 'open');
  assert.equal(preArmRearm(c, T, 24 * 3600_000), null);
});

test('late: endTime passed is permanent, never re-armed', () => {
  const c = classifySeaDropWindow(drop(T / 1000 - 3600, T / 1000 - 60), T);
  assert.equal(c.phase, 'late');
  assert.equal(preArmRearm(c, T, 24 * 3600_000), null);
});

test('no endTime set means the window never closes', () => {
  const c = classifySeaDropWindow(drop(T / 1000 - 3600, 0), T);
  assert.equal(c.phase, 'open');
  assert.equal(c.endTimeMs, null);
});

test('pre-arm re-arm is bounded by the re-arm window: a day-late drop is not a timer move', () => {
  const c = classifySeaDropWindow(drop(T / 1000 + 25 * 3600), T);
  assert.equal(c.phase, 'early');
  assert.equal(preArmRearm(c, T, 24 * 3600_000), null, 'outside the 24h window');
  const inside = preArmRearm(c, T, 26 * 3600_000);
  assert.equal(inside.fireAtMs, T + 25 * 3600 * 1000, 'inside a wider window it moves');
});

test('a drop that already opened before the schedule is open, not a backward move', () => {
  // Project opened 30s EARLY relative to the advertised T. At pre-arm time (T-12s) startTime has
  // already passed -> open -> keep firing at T; the drift check will pass.
  const c = classifySeaDropWindow(drop(T / 1000 - 30), T - 12_000);
  assert.equal(c.phase, 'open');
  assert.equal(preArmRearm(c, T, 24 * 3600_000), null);
});
