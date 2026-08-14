// Milestone 16b: periodically evaluates governance-group assignments whose scheduled_removal_at
// has come due, renewing (pushing the schedule out by the group's configured retention period) or
// removing the user from the group, depending on the group's configured retention policy and the
// user's subscription/good-standing flags and recent bot activity. This only ever changes group
// *assignment* -- it never bans, suspends, or deactivates the account itself (that is Milestone
// 16a, and is either done directly by an owner or from an entirely separate enforcement path).
function evaluateRetention(item, { now = () => Date.now() } = {}) {
  if (item.goodStandingOverride) return { renew: true, reason: 'good standing override' };
  const reasons = [];
  if (item.requireActiveSubscription && !item.subscriptionActive) reasons.push('subscription is not active');
  if (item.requireRecentActivityDays) {
    const cutoff = now() - item.requireRecentActivityDays * 86_400_000;
    const lastActivityMs = item.lastActivityAt ? new Date(item.lastActivityAt).getTime() : null;
    if (!lastActivityMs || lastActivityMs < cutoff) {
      reasons.push(`no activity within ${item.requireRecentActivityDays} day(s)`);
    }
  }
  if (reasons.length) return { renew: false, reason: reasons.join('; ') };
  return { renew: true, reason: 'retention criteria met' };
}

function createRetentionWorker({ repository, now = () => Date.now(), intervalMs = 60_000, log = () => {} }) {
  let timer = null;
  let running = false;
  let lastTickAt = null;
  let lastSuccessAt = null;
  let lastError = null;

  async function processDueItem(item) {
    const decision = evaluateRetention(item, { now });
    if (decision.renew) {
      // A group's retention_period_days is nullable (retention scheduling is opt-in per group), but
      // a scheduled_removal_at can only exist because something set it while the group had a period
      // configured -- if the period was since cleared, fall back to 30 days rather than looping the
      // same due item every tick indefinitely.
      const periodDays = item.retentionPeriodDays || 30;
      const nextScheduledRemovalAt = new Date(now() + periodDays * 86_400_000);
      await repository.renewRetention({
        userId: item.userId, groupId: item.groupId, previousScheduledRemovalAt: item.scheduledRemovalAt,
        nextScheduledRemovalAt, reason: decision.reason,
      });
    } else {
      await repository.removeFromGroupForRetention({
        userId: item.userId, groupId: item.groupId, previousScheduledRemovalAt: item.scheduledRemovalAt,
        reason: decision.reason,
      });
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    lastTickAt = now();
    try {
      const due = await repository.listDueRetentions(new Date(now()));
      for (const item of due) {
        try { await processDueItem(item); }
        catch (error) { log(`Retention evaluation failed for user ${item.userId} in group ${item.groupName}: ${error.message}`); }
      }
      lastSuccessAt = now();
      lastError = null;
    } catch (error) {
      lastError = String(error?.message || 'retention poll failed').slice(0, 200);
      log(`Retention worker poll failed safely: ${error.message}`);
    } finally { running = false; }
  }

  return {
    start() { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref?.(); void tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    health() { return { status: timer && (!lastError || lastSuccessAt >= lastTickAt) ? 'up' : 'down',
      running: Boolean(timer), active: running, lastTickAt, lastSuccessAt, lastError }; },
    tick,
  };
}

module.exports = { createRetentionWorker, evaluateRetention };
