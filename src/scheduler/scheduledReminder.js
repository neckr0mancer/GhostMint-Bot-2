const DEFAULT_LEAD_MS = 5 * 60 * 1000;
const PENDING_STATUSES = new Set(['scheduled', 'retry', 'claimed']);

function createScheduledReminder({
  getTasks,
  findWallet,
  detectSoldOut,
  cancelTask,
  calculateNeededWei,
  getBalance,
  formatWei,
  escape = value => String(value),
  notify,
  broadcast,
  log = () => {},
  leadMs = DEFAULT_LEAD_MS,
}) {
  const reminderSent = new Set();
  const lowBalanceWarned = new Set();
  // A phase-aware scheduler can move mintTime after a launch delay. Key delivery by both task and
  // current fire time so the newly verified window receives its own five-minute reminder instead
  // of being suppressed by the reminder sent for the stale advertised time.
  const deliveryKey = task => `${task.id}:${task.mintTime}`;

  async function sendReminder(task, wallet, minutes, lowBalance = null) {
    const key = deliveryKey(task);
    const phaseAware = Boolean(task.eligibilityDeadline);
    const timing = phaseAware ? `eligibility checks begin in ${minutes}m` : `mints in ${minutes}m`;
    const automatic = phaseAware
      ? 'It will mint automatically once a live phase accepts this wallet; no approval is required.'
      : 'It will execute automatically; no approval is required.';
    if (lowBalance) {
      await notify(task.userId,
        `⚠️ <b>${escape(task.name)}</b> ${timing} and <b>${escape(wallet.label)}</b> is short by ${escape(lowBalance)} ETH. ${automatic}`);
      broadcast(task.userId, { type: 'task.lowBalance', taskId: task.id, name: task.name,
        walletLabel: wallet.label, shortByEth: lowBalance, minutes, automatic: true });
      lowBalanceWarned.add(key);
    } else {
      await notify(task.userId,
        `⏰ Scheduled mint <b>${escape(task.name)}</b> ${timing} from <b>${escape(wallet.label)}</b>. ${automatic}`);
      broadcast(task.userId, { type: 'task.reminder', taskId: task.id, name: task.name,
        walletLabel: wallet.label, minutes, automatic: true });
    }
    reminderSent.add(key);
  }

  async function sweep(now = Date.now()) {
    const due = getTasks().filter(task =>
      PENDING_STATUSES.has(String(task.status || '').toLowerCase())
      && typeof task.mintTime === 'number'
      && task.mintTime > now
      && task.mintTime - now <= leadMs);

    for (const task of due) {
      try {
        const key = deliveryKey(task);
        const wallet = findWallet(task);
        if (!wallet) continue;

        if (await detectSoldOut(task)) {
          await cancelTask(task);
          await notify(task.userId, `⚠️ <b>${escape(task.name)}</b> was cancelled because the mint sold out before its scheduled time. Nothing was sent.`);
          broadcast(task.userId, { type: 'task.autoCancelled', taskId: task.id, name: task.name, reason: 'sold_out' });
          reminderSent.add(key);
          lowBalanceWarned.add(key);
          continue;
        }

        // Delivery flags suppress duplicate reminders, not safety checks. A free mint used to set
        // both flags on the first sweep and then skip every later sold-out check, so supply could
        // exhaust during the remaining five minutes and the user would only see a generic failure.
        if (reminderSent.has(key) && lowBalanceWarned.has(key)) continue;

        const minutes = Math.max(1, Math.round((task.mintTime - now) / 60000));
        const needed = await calculateNeededWei(task, wallet);
        if (needed <= 0n) {
          if (!reminderSent.has(key)) await sendReminder(task, wallet, minutes);
          lowBalanceWarned.add(key);
          continue;
        }

        const balance = await getBalance(wallet);
        if (balance < needed) {
          const short = formatWei(needed - balance);
          if (!reminderSent.has(key)) await sendReminder(task, wallet, minutes, short);
          else if (!lowBalanceWarned.has(key)) {
            await notify(task.userId,
              `⚠️ <b>${escape(task.name)}</b> ${task.eligibilityDeadline ? `eligibility checks begin in ${minutes}m` : `mints in ${minutes}m`} and <b>${escape(wallet.label)}</b> is now short by ${escape(short)} ETH. Top up before automatic execution.`);
            broadcast(task.userId, { type: 'task.lowBalance', taskId: task.id, name: task.name,
              walletLabel: wallet.label, shortByEth: short, minutes, automatic: true });
            lowBalanceWarned.add(key);
          }
        } else if (!reminderSent.has(key)) {
          await sendReminder(task, wallet, minutes);
        }
      } catch (error) {
        log(`Scheduled reminder failed for task ${task.id}: ${error?.message || 'unknown error'}`);
      }
    }
    return due.length;
  }

  return { sweep };
}

module.exports = { DEFAULT_LEAD_MS, createScheduledReminder };
