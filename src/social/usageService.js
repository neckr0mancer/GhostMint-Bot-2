const DAY_MS = 86_400_000;

function periodStart(period, now) {
  const date = new Date(now);
  if (period === 'today') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (period === 'day') return now - DAY_MS;
  if (period === 'week') return now - (7 * DAY_MS);
  if (period === 'month') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  throw new Error('Usage period must be today, day, week, or month');
}

function createSocialUsageService({ repository, governance, pricing, now = () => Date.now() }) {
  async function summary(callerUserId, period = 'month') {
    await governance.requireOwner(callerUserId);
    const since = periodStart(period, now());
    const rows = await repository.usageSince(since);
    const requests = rows.reduce((sum, row) => sum + row.requests, 0);
    const readRequests = rows.filter(row => row.requestType !== 'post').reduce((sum,row) => sum + row.requests,0);
    const postRequests = rows.filter(row => row.requestType === 'post').reduce((sum,row) => sum + row.requests,0);
    const payPerUseEstimateUsd = readRequests * pricing.officialReadUsd + postRequests * pricing.officialPostUsd;
    const elapsedDays = Math.max(1, (now() - since) / DAY_MS);
    const projectedMonthlyRequests = period === 'today' ? requests * 30 : requests / elapsedDays * 30;
    return { period, since, requests, rows, reportedCostUsd:rows.reduce((sum,row)=>sum+row.reportedCostUsd,0),
      reportedCredits:rows.reduce((sum,row)=>sum+row.reportedCredits,0), payPerUseEstimateUsd,
      projectedMonthlyRequests, pricing, breakEvenRequests: pricing.managedMonthlyTiersUsd.map(price => ({
        price, atReadRate:Math.ceil(price / pricing.officialReadUsd), atPostRate:Math.ceil(price / pricing.officialPostUsd),
      })) };
  }
  return { summary };
}

function formatUsageSummary(summary) {
  const rows = summary.rows.length ? summary.rows.map(row =>
    `- ${row.ruleName} | ${row.method} | ${row.requestType}: ${row.requests}`).join('\n') : '- No requests recorded.';
  const tiers = summary.breakEvenRequests.map(tier =>
    `$${tier.price}/month breaks even at ~${tier.atReadRate.toLocaleString('en-US')} reads or ${tier.atPostRate.toLocaleString('en-US')} posts`).join('\n');
  return `Social adapter usage (${summary.period})\nTotal requests: ${summary.requests}\n${rows}\n\nObserved provider cost: $${summary.reportedCostUsd.toFixed(4)}; credits: ${summary.reportedCredits.toFixed(2)}\nEstimated X pay-per-use: ~$${summary.payPerUseEstimateUsd.toFixed(2)} (${summary.pricing.officialReadUsd}/read, ${summary.pricing.officialPostUsd}/post)\nProjected monthly requests: ~${Math.round(summary.projectedMonthlyRequests).toLocaleString('en-US')}\n${tiers}`;
}

module.exports = { createSocialUsageService, formatUsageSummary, periodStart };
