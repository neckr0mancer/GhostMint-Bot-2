const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(
  pathToFileURL(path.join(__dirname, '..', 'dashboard', 'src', 'pnlChart.js')).href);

const day = 86400000;
const at = daysAgo => Date.now() - daysAgo * day;
const record = (net, daysAgo, over = {}) => ({ nm: 'r', cost: 0, sale: 0, gas: 0, net, t: at(daysAgo), ...over });

test('a day holding both a gain and a loss draws both, not their net', async () => {
  const { pnlDailyBuckets } = await load();
  // This is the bug the owner reported: netting +0.398 against -0.361 left one small green bar
  // above a records list that plainly showed a red and a green.
  const { buckets } = pnlDailyBuckets([record(0.398, 1), record(-0.361, 1)], 7);
  const busy = buckets.filter(b => b.gain || b.loss);
  assert.equal(busy.length, 1, 'both records fall on the same day');
  assert.equal(Number(busy[0].gain.toFixed(6)), 0.398, 'the gain survives in full');
  assert.equal(Number(busy[0].loss.toFixed(6)), -0.361, 'and so does the loss');
});

test('same-day records of the same sign accumulate', async () => {
  const { pnlDailyBuckets } = await load();
  const { buckets } = pnlDailyBuckets([record(-0.1, 2), record(-0.2, 2)], 7);
  const busy = buckets.filter(b => b.loss);
  assert.equal(busy.length, 1);
  assert.equal(Number(busy[0].loss.toFixed(6)), -0.3);
});

test('quiet days keep their slot so the timeline is not compressed', async () => {
  const { pnlDailyBuckets } = await load();
  const { buckets, span } = pnlDailyBuckets([record(0.5, 0), record(0.5, 6)], 7);
  assert.equal(span, 7, 'a 7-day window is seven slots wide');
  assert.equal(buckets.length, 7);
  assert.equal(buckets.filter(b => b.gain || b.loss).length, 2, 'the five empty days are still there');
});

test('records outside the window are excluded, and null means all time', async () => {
  const { pnlDailyBuckets } = await load();
  const rows = [record(1, 1), record(2, 45), record(3, 200)];
  const week = pnlDailyBuckets(rows, 7);
  assert.equal(week.buckets.reduce((sum, b) => sum + b.gain, 0), 1, 'only the 1-day-old row');
  const quarter = pnlDailyBuckets(rows, 90);
  assert.equal(quarter.buckets.reduce((sum, b) => sum + b.gain, 0), 3, 'the 45-day row joins it');
  const all = pnlDailyBuckets(rows, null);
  assert.equal(all.buckets.reduce((sum, b) => sum + b.gain, 0), 6, 'null reaches the 200-day row');
});

test('an empty or missing record list yields a chart rather than throwing', async () => {
  const { pnlDailyBuckets } = await load();
  assert.equal(pnlDailyBuckets([], 30).buckets.length, 30);
  assert.equal(pnlDailyBuckets(null, 30).buckets.length, 30);
  assert.equal(pnlDailyBuckets([], null).span >= 1, true, 'all-time over nothing is still one slot');
});

test('window totals sum only what is inside the window', async () => {
  const { pnlWindowTotals } = await load();
  const rows = [
    record(-0.11, 1, { cost: 0.1, gas: 0.01 }),
    record(-0.22, 45, { cost: 0.2, gas: 0.02 }),
  ];
  const week = pnlWindowTotals(rows, 7);
  assert.equal(week.records, 1);
  assert.equal(Number(week.cost.toFixed(6)), 0.1);
  assert.equal(Number(week.net.toFixed(6)), -0.11);
  assert.equal(pnlWindowTotals(rows, null).records, 2, 'null means all time here too');
});

test('ROI is measured against cost plus gas, and is undefined when nothing was spent', async () => {
  const { pnlWindowTotals } = await load();
  // Gas is spent whether or not a token ever resells, so excluding it would flatter every return.
  const spent = pnlWindowTotals([record(0.398, 1, { cost: 0.712, sale: 1.241, gas: 0.131 })], 7);
  assert.equal(Number(spent.outlay.toFixed(6)), 0.843);
  assert.equal(Math.round(spent.roi * 10) / 10, 47.2);

  const nothing = pnlWindowTotals([], 7);
  assert.equal(nothing.roi, undefined,
    'no outlay means there is no return to express -- not a 0% one');
  assert.equal(nothing.net, 0, 'but the net of nothing is a real zero');
});
