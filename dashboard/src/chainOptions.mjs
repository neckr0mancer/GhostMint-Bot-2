// The authenticated profile is the dashboard's source of truth for EVM support. The server builds
// this list from the same CONFIG.supportedChains used by Telegram, Discord, provider detection,
// validation, and transaction execution. Keeping a second browser-side allowlist would let a
// configured chain work through the bots while silently disappearing from dashboard controls.
export function dashboardEvmChains(options=[]){
  return [...new Set(options
    .map(value=>String(value||'').trim().toLowerCase())
    .filter(value=>value&&value!=='solana'))];
}
