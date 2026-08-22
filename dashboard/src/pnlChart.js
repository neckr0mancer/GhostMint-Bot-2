// Daily P&L buckets for the Net-by-day chart.
//
// Gains and losses are kept APART per day rather than netted into one bar. Netting is what made
// the chart look broken: a day holding a +0.398 record and a -0.361 record collapsed to a single
// small green bar, so a records list full of reds and greens sat under a chart showing neither.
// A day now draws its gains above the baseline and its losses below, which is also how every
// trading surface draws this — green above for gain, red below for loss.
//
// One bucket per DAY, not per record: two mints on the same day are one day's result, and days
// with nothing still occupy their slot so a gap reads as a quiet day rather than compressing the
// timeline.

const DAY_MS = 86400000;

function startOfDay(value) {
  const at = new Date(value);
  at.setHours(0, 0, 0, 0);
  return at.getTime();
}

// days === null means all time, measured from the earliest record present.
export function pnlDailyBuckets(records, days) {
  const rows = Array.isArray(records) ? records : [];
  const today = startOfDay(Date.now());
  const earliest = rows.length
    ? rows.reduce((low, item) => Math.min(low, item.t), Infinity)
    : Date.now();
  const first = startOfDay(days === null || days === undefined
    ? earliest
    : Date.now() - (days - 1) * DAY_MS);
  const span = Math.max(1, Math.round((today - first) / DAY_MS) + 1);
  const buckets = Array.from({ length: span }, () => ({ gain: 0, loss: 0 }));
  for (const item of rows) {
    const index = Math.round((startOfDay(item.t) - first) / DAY_MS);
    if (index < 0 || index >= span) continue;
    const net = Number(item.net) || 0;
    if (net < 0) buckets[index].loss += net; else buckets[index].gain += net;
  }
  return { buckets, first, span };
}

// The single figure the chart's aria-label and the snapshot headline both quote.
export function pnlWindowTotals(records, days) {
  const rows = Array.isArray(records) ? records : [];
  const cutoff = days === null || days === undefined ? -Infinity : Date.now() - days * DAY_MS;
  const inWindow = rows.filter(item => item.t >= cutoff);
  const sum = key => inWindow.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  const cost = sum('cost');
  const gas = sum('gas');
  const net = sum('net');
  // Return on what was actually put in. Cost plus gas is the outlay -- gas is spent whether or not
  // a token ever resells, so leaving it out would flatter every number here. Undefined rather than
  // 0 when nothing was spent: no outlay means no return to express, not a 0% one.
  const outlay = cost + gas;
  return {
    records: inWindow.length,
    cost,
    gas,
    sale: sum('sale'),
    net,
    outlay,
    roi: outlay > 0 ? (net / outlay) * 100 : undefined,
  };
}
