// Per-wallet performance, derived from P&L records.
//
// pnl_records has no wallet column (001_initial_schema.sql), so at first glance cost and gas cannot
// be attributed to a wallet at all. They can: autoRecordPnl in src/server.js writes every confirmed
// mint as "Minted {n} NFT{s} — {wallet.label}", so the wallet and the quantity are both recoverable
// from the row, and the cost and gas on it are real numbers off the confirmed receipt rather than
// estimates.
//
// This lives in its own module, not inside App.jsx, for the same reason batchRow.js does: it parses
// a string format owned by the SERVER, so it can drift without anything failing loudly. The test in
// tests/walletPerformance.test.js reads that template out of server.js and asserts this parser
// still understands it, which is the alarm for exactly that drift.
//
// The honest limits, which the Wallets page states rather than hides:
//   - a record renamed by hand stops matching, and a hand-added one never did
//   - net starts at -(cost + gas) and only turns positive once a resale is entered by hand, so a
//     wallet that minted profitably still reads as a loss until someone records the sale

// Greedy on purpose: the regex engine takes the LEFTMOST em-dash and captures everything after it,
// so a label that itself contains " — " survives intact instead of being truncated at its own dash.
const PNL_NAME_WALLET = /\s—\s(.+)$/;
const PNL_NAME_QUANTITY = /^Minted\s+(\d+)\s+NFT/;

export function pnlWalletLabel(record) {
  const match = PNL_NAME_WALLET.exec(String(record?.nm || ''));
  return match ? match[1].trim() : null;
}

export function pnlMintedQuantity(record) {
  const match = PNL_NAME_QUANTITY.exec(String(record?.nm || ''));
  return match ? Number(match[1]) : 0;
}

// windowMs of null means all time. Returns null for a records list that has not loaded yet, so the
// caller can render "—" rather than a confident 0 for a figure it does not have.
export function walletPerformance(records, label, windowMs) {
  if (!Array.isArray(records)) return null;
  const cutoff = windowMs === null || windowMs === undefined ? -Infinity : Date.now() - windowMs;
  const mine = records.filter(item => item.t >= cutoff && pnlWalletLabel(item) === label);
  const sum = key => mine.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  return {
    minted: mine.reduce((total, item) => total + pnlMintedQuantity(item), 0),
    cost: sum('cost'),
    gas: sum('gas'),
    net: sum('net'),
  };
}
