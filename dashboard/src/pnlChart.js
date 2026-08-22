// Shared P&L chart data and geometry. Performance, its PNG snapshot, and Home all consume these
// helpers so they cannot quietly drift into three different interpretations.

const DAY_MS = 86400000;

function startOfDay(value) {
  const at = new Date(value);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

function timestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

// A bar represents one real P&L record. Records from the same day stay next to one another instead
// of being summed or drawn on top of each other. The day remains attached to every point for the
// tooltip and accessible description, while every gain/loss remains visible in its own right.
export function pnlRecordSeries(records, days) {
  const rows = Array.isArray(records) ? records : [];
  const today = startOfDay(Date.now());
  const dated = rows.map((item, sourceIndex) => ({
    item,
    sourceIndex,
    t: timestamp(item?.t),
    net: Number(item?.net) || 0,
  })).filter(row => row.t !== null);
  const earliest = dated.length ? Math.min(...dated.map(row => row.t)) : Date.now();
  const first = startOfDay(days === null || days === undefined
    ? earliest
    : Date.now() - (days - 1) * DAY_MS);
  const last = today + DAY_MS;
  const points = dated
    .filter(row => row.t >= first && row.t < last)
    .sort((left, right) => left.t - right.t || left.sourceIndex - right.sourceIndex)
    .map((row, index) => ({
      id: row.item.id || `${row.t}-${row.sourceIndex}`,
      day: new Date(row.t).toISOString().slice(0, 10),
      label: row.item.nm || `Record ${index + 1}`,
      net: row.net,
      t: row.t,
      index,
    }));
  return {
    points,
    first,
    span: Math.max(1, Math.round((today - first) / DAY_MS) + 1),
    dayCount: new Set(points.map(point => point.day)).size,
  };
}

// Geometry is shared with the PNG snapshot. Each record owns one equal-width slot and normally
// fills that slot with a two-pixel gap, matching the prototype. Compact callers can still cap
// maxBarWidth explicitly. No two records ever share an x-position.
export function pnlBarLayout(points, { width = 620, height = 112, gap = 2, maxBarWidth = Infinity } = {}) {
  const rows = Array.isArray(points) ? points : [];
  const baseline = height / 2;
  const peak = rows.reduce((high, point) => Math.max(high, Math.abs(point.net)), 0);
  const slot = width / Math.max(1, rows.length);
  const effectiveGap = Math.min(gap, slot / 3);
  const barWidth = Math.max(0.5, Math.min(maxBarWidth, slot - effectiveGap));
  const scale = peak > 0 ? (height / 2 - 4) / peak : 0;
  return {
    baseline,
    peak,
    bars: rows.map((point, index) => ({
      ...point,
      x: index * slot + (slot - barWidth) / 2,
      width: barWidth,
      end: baseline - point.net * scale,
      height: Math.abs(point.net * scale),
    })),
  };
}

// The small Home-tile sparkline is a portfolio trend, not a second bar chart. Plotting each
// record's isolated result made a positive total look as though it finished below where it began.
// Starting at zero and accumulating every ordered record makes the end position agree with the
// signed headline while still showing the losses encountered on the way there.
export function cumulativePnlPoints(points) {
  const rows = Array.isArray(points) ? points : [];
  let total = 0;
  return [0, ...rows.map(point => {
    total += Number(point?.net) || 0;
    return total;
  })];
}

export function pnlWindowTotals(records, days) {
  const rows = Array.isArray(records) ? records : [];
  const first = days === null || days === undefined
    ? -Infinity
    : startOfDay(Date.now() - (days - 1) * DAY_MS);
  const last = startOfDay(Date.now()) + DAY_MS;
  const inWindow = rows.filter(item => {
    const at = timestamp(item?.t);
    return at !== null && at >= first && at < last;
  });
  const sum = key => inWindow.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  const cost = sum('cost');
  const gas = sum('gas');
  const net = sum('net');
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
