// The third column of a .bres row: a transaction hash when the wallet confirmed, the reason when
// it did not. /api/mint/confirm answers {label,status,result} on success -- the hash is at
// result.txHash, NOT at entry.transactionHash, which never existed. Reading the wrong field
// rendered an empty span for every SUCCESSFUL wallet while failures showed their reason correctly,
// so a batch looked worse the better it went. Falls back across the shapes the bots' batchMint
// returns too, since both feed rows of the same shape.
export function batchRowDetail(entry){
  if(!entry)return '';
  if(entry.status==='success'||entry.state==='confirmed'){
    return entry.result?.txHash||entry.txHash||entry.transactionHash||'';
  }
  return entry.error||entry.reason||'';
}
