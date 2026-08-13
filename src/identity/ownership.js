function stateForUser(state, userId) {
  return {
    wallets: state.wallets.filter(item => item.userId === userId),
    tasks: state.tasks.filter(item => item.userId === userId),
    activity: state.activity.filter(item => item.userId === userId),
    pnl: state.pnl.filter(item => item.userId === userId),
    snipers: state.snipers.filter(item => item.userId === userId),
  };
}

function findOwnedWallet(state, userId, label) {
  const normalized = String(label).toLowerCase();
  return state.wallets.find(wallet => wallet.userId === userId && wallet.label.toLowerCase() === normalized) || null;
}

function findOwnedTask(state, userId, taskId) {
  return state.tasks.find(task => task.userId === userId && task.id === taskId) || null;
}

module.exports = { findOwnedTask, findOwnedWallet, stateForUser };
