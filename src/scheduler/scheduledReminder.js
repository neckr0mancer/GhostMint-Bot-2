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

  async function sendReminder(task, wallet, minutes, lowBalance = null) {
    const automatic = 'It will execute automatically; no approval is required.';
    if (lowBalance) {
      await notify(task.userId,
        `⚠️ <b>${escape(task.name)}</b> mints in ${minutes}m and <b>${escape(wallet.label)}</b> is short by ${escape(lowBalance)} ETH. ${automatic}`);
      broadcast(task.userId, { type: 'task.lowBalance', taskId: task.id, name: task.name,
        walletLabel: wallet.label, shortByEth: lowBalance, minutes, automatic: true });
      lowBalanceWarned.add(task.id);
    } else {
      await notify(task.userId,
        `⏰ Scheduled mint <b>${escape(task.name)}</b> runs in ${minutes}m from <b>${escape(wallet.label)}</b>. ${automatic}`);
      broadcast(task.userId, { type: 'task.reminder', taskId: task.id, name: task.name,
        walletLabel: wallet.label, minutes, automatic: true });
    }
    reminderSent.add(task.id);
  }

  async function sweep(now = Date.now()) {
    const due = getTasks().filter(task =>
      PENDING_STATUSES.has(String(task.status || '').toLowerCase())
      && typeof task.mintTime === 'number'
      && task.mintTime > now
      && task.mintTime - now <= leadMs
      && !(reminderSent.has(task.id) && lowBalanceWarned.has(task.id)));

    for (const task of due) {
      try {
        const wallet = findWallet(task);
        if (!wallet) continue;

        if (await detectSoldOut(task)) {
          await cancelTask(task);
          await notify(task.userId, `🛑 <b>${escape(task.name)}</b> was auto-cancelled -- the collection already sold out.`);
          broadcast(task.userId, { type: 'task.autoCancelled', taskId: task.id, name: task.name, reason: 'sold_out' });
          reminderSent.add(task.id);
          lowBalanceWarned.add(task.id);
          continue;
        }

        const minutes = Math.max(1, Math.round((task.mintTime - now) / 60000));
        const needed = calculateNeededWei(task);
        if (needed <= 0n) {
          if (!reminderSent.has(task.id)) await sendReminder(task, wallet, minutes);
          lowBalanceWarned.add(task.id);
          continue;
        }

        const balance = await getBalance(wallet);
        if (balance < needed) {
          const short = formatWei(needed - balance);
          if (!reminderSent.has(task.id)) await sendReminder(task, wallet, minutes, short);
          else if (!lowBalanceWarned.has(task.id)) {
            await notify(task.userId,
              `⚠️ <b>${escape(task.name)}</b> mints in ${minutes}m and <b>${escape(wallet.label)}</b> is now short by ${escape(short)} ETH. Top up before automatic execution.`);
            broadcast(task.userId, { type: 'task.lowBalance', taskId: task.id, name: task.name,
              walletLabel: wallet.label, shortByEth: short, minutes, automatic: true });
            lowBalanceWarned.add(task.id);
          }
        } else if (!reminderSent.has(task.id)) {
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
