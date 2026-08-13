class WalletNonceQueue {
  constructor() {
    this.tails = new Map();
  }

  run(walletKey, operation) {
    const previous = this.tails.get(walletKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.tails.set(walletKey, current);
    current.finally(() => {
      if (this.tails.get(walletKey) === current) this.tails.delete(walletKey);
    }).catch(() => {});
    return current;
  }
}

module.exports = { WalletNonceQueue };
