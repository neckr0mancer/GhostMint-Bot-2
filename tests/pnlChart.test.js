const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(
  pathToFileURL(path.join(__dirname, '..', 'dashboard', 'src', 'pnlChart.js')).href);

const day = 86400000;
const at = (daysAgo, offset = 0) => Date.now() - daysAgo * day + offset;
let sequence = 0;
const record = (net, daysAgo, over = {}) => ({ id:`record-${++sequence}`, nm:'r', cost:0, sale:0,
  gas:0, net, t:at(daysAgo), ...over });

test('every same-day gain and loss remains a separate plotted point', async () => {
  const { pnlRecordSeries } = await load();
  const rows = [
    record(-0.084, 1, {t:at(1, 1)}),
    record(-0.361, 1, {t:at(1, 2)}),
    record(0.398, 1, {t:at(1, 3)}),
    record(-0.054, 1, {t:at(1, 4)}),
    record(0.218, 1, {t:at(1, 5)}),
  ];
  const series = pnlRecordSeries(rows, 7);
  assert.equal(series.dayCount, 1, 'all records really are on one day');
  assert.equal(series.points.length, 5, 'none are collapsed into a gain/loss pair or daily net');
  assert.deepEqual(series.points.map(point => point.net), [-0.084, -0.361, 0.398, -0.054, 0.218]);
});

test('bar geometry assigns every record a distinct non-overlapping x range', async () => {
  const { pnlBarLayout, pnlRecordSeries } = await load();
  const points = pnlRecordSeries([
    record(-0.1, 1, {t:at(1, 1)}), record(-0.2, 1, {t:at(1, 2)}),
    record(0.3, 1, {t:at(1, 3)}), record(0.4, 1, {t:at(1, 4)}),
  ], 7).points;
  const { bars, baseline } = pnlBarLayout(points, {width:120, height:60});
  for (let index = 1; index < bars.length; index++) {
    assert.ok(bars[index - 1].x + bars[index - 1].width < bars[index].x,
      `bar ${index} must start after bar ${index - 1} ends`);
    assert.equal(bars[index].width,bars[0].width,'every record owns an equal share of the plot');
  }
  assert.equal(bars[0].width,28,'four bars fill four 30px slots with the requested 2px gap');
  assert.ok(bars[0].end > baseline, 'loss extends below the baseline');
  assert.ok(bars[2].end < baseline, 'gain extends above the baseline');
});

test('Home sparkline is cumulative and its endpoint equals the displayed net total', async () => {
  const { cumulativePnlPoints } = await load();
  const points=[-0.084,-0.361,0.398,-0.054,0.218].map(net=>({net}));
  const trend=cumulativePnlPoints(points);
  assert.equal(trend[0],0,'the visual begins at the zero baseline');
  assert.equal(Number(trend.at(-1).toFixed(6)),0.117,'the endpoint agrees with +0.117 ETH');
  assert.ok(Math.min(...trend)<0,'losses on the way remain visible');
  assert.ok(trend.at(-1)>trend[0],'a positive total finishes above its starting point');
});

test('records outside the window are excluded, and null means all time', async () => {
  const { pnlRecordSeries } = await load();
  const rows = [record(1, 1), record(2, 45), record(3, 200)];
  assert.deepEqual(pnlRecordSeries(rows, 7).points.map(point=>point.net), [1]);
  assert.deepEqual(pnlRecordSeries(rows, 90).points.map(point=>point.net), [2,1]);
  assert.deepEqual(pnlRecordSeries(rows, null).points.map(point=>point.net), [3,2,1]);
});

test('an empty or missing record list yields an empty series rather than throwing', async () => {
  const { pnlRecordSeries, pnlBarLayout } = await load();
  assert.deepEqual(pnlRecordSeries([], 30).points, []);
  assert.deepEqual(pnlRecordSeries(null, 30).points, []);
  assert.equal(pnlRecordSeries([], null).span >= 1, true);
  assert.deepEqual(pnlBarLayout(null).bars, []);
});

test('window totals use the same calendar window as the plotted series', async () => {
  const { pnlRecordSeries, pnlWindowTotals } = await load();
  const rows = [
    record(-0.11, 1, { cost:0.1, gas:0.01 }),
    record(-0.22, 45, { cost:0.2, gas:0.02 }),
  ];
  const week = pnlWindowTotals(rows, 7);
  assert.equal(week.records, pnlRecordSeries(rows, 7).points.length);
  assert.equal(Number(week.cost.toFixed(6)), 0.1);
  assert.equal(Number(week.net.toFixed(6)), -0.11);
  assert.equal(pnlWindowTotals(rows, null).records, 2);
});

test('ROI is measured against cost plus gas, and is undefined when nothing was spent', async () => {
  const { pnlWindowTotals } = await load();
  const spent = pnlWindowTotals([record(0.398, 1, { cost:0.712, sale:1.241, gas:0.131 })], 7);
  assert.equal(Number(spent.outlay.toFixed(6)), 0.843);
  assert.equal(Math.round(spent.roi * 10) / 10, 47.2);
  const nothing = pnlWindowTotals([], 7);
  assert.equal(nothing.roi, undefined);
  assert.equal(nothing.net, 0);
});
