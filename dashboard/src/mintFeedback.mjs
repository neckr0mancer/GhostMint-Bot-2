const ETH_CHAINS=new Set(['ethereum','base','arbitrum','optimism','robinhood']);

export function nativeCurrencyForChain(chain){
  if(ETH_CHAINS.has(chain))return 'ETH';
  if(chain==='polygon')return 'POL';
  if(chain==='bsc')return 'BNB';
  if(chain==='avalanche')return 'AVAX';
  return 'funds';
}

export function mintDetectionMessage(error){
  const text=String(error?.message||'');
  if(/not found|no contract|does not contain contract code/i.test(text))return 'We could not find a mint contract at this address. Check the address and try again.';
  if(/timeout|network|rpc|provider|fetch failed|unavailable/i.test(text))return 'We could not check this contract right now. Try again in a moment.';
  return 'We could not check this contract. Check the address and try again.';
}

export function mintPreviewError(error,{chain,quantity}={}){
  // Batch failures arrive as "${field} ${message}" (the repository's issue format), so a leading
  // field name must be stripped before phrase matching -- "contractAddress Drop is not…" would
  // otherwise never match patterns written for the sentence alone.
  const text=String(error?.message||'')
    .replace(/^(walletLabel|contractAddress|quantity|methodSignature|mintTime|chain|priceETH|stageUuid|stageLabel|eligibilityMode)\s+/i,'');
  const code=String(error?.code||'');
  const currency=nativeCurrencyForChain(chain);
  const canLowerQuantity=Number.isFinite(Number(quantity))&&Number(quantity)>1;
  const insufficient=code==='INSUFFICIENT_BALANCE'
    ||/insufficient funds|cannot cover the mint price plus the network fee|balance is below/i.test(text);
  if(insufficient)return {
    title:`Not enough ${currency} for this mint.`,
    detail:canLowerQuantity
      ?'Fund this wallet, use another wallet with enough balance, or lower the quantity.'
      :'Fund this wallet or use another wallet with enough balance.'
  };
  if(code==='STAGE_NOT_OPEN'||/not (currently )?active|not opened|not yet open|opens \d|opening time/i.test(text))return {title:'This mint is not open yet.',detail:'Check the opening time and try again later.'};
  if(code==='GAS_CEILING_EXCEEDED'||code==='GAS_TOLERANCE_EXCEEDED')return {title:'Gas is above your limit.',detail:'Raise the wallet gas limit before trying again.'};
  if(code==='VALUE_CEILING_EXCEEDED')return {
    title:'This mint is above your spending limit.',
    detail:canLowerQuantity?'Lower the quantity or increase the wallet limit.':'Increase the wallet limit before trying again.'
  };
  if(code==='DAILY_BUDGET_EXCEEDED')return {
    title:'This wallet reached its daily spending limit.',
    detail:canLowerQuantity?'Lower the quantity, wait for the limit to reset, or use another wallet.':'Wait for the limit to reset or use another wallet.'
  };
  if(code==='FEE_UNAVAILABLE'||/fee data|network fee/i.test(text)&&/unavailable|could not|did not return/i.test(text))return {title:'We could not get the network fee.',detail:'Try again in a moment.'};
  if(code==='WRONG_CHAIN')return {title:'The network is on the wrong chain.',detail:'Try again or check the RPC settings for this chain.'};
  const walletLimit=text.match(/would hold\s+(\d+),\s*exceeding the\s+(\d+) allowed per wallet/i);
  if(walletLimit){const total=Number(walletLimit[1]);const allowed=Number(walletLimit[2]);const requested=Number(quantity);const already=Number.isFinite(requested)&&requested>0?Math.max(0,total-requested):null;const remaining=already===null?null:Math.max(0,allowed-already);return remaining===0
    ?{title:"This wallet has reached this mint's limit.",detail:'Use another eligible wallet.'}
    :remaining!==null
      ?{title:`This wallet can mint ${remaining} more.`,detail:`Lower its quantity to ${remaining} or use another wallet.`}
      :{title:`This mint allows ${allowed} per wallet.`,detail:'Lower the quantity or use another wallet.'};}
  if(/sold out|max supply/i.test(text))return {title:'This mint is sold out.',detail:'No transaction was sent.'};
  if(/couldn.t prepare a supported mint call|no mintable stage/i.test(text))return {title:'No mintable stage is open for this contract.',detail:'It was recognized, but every stage is closed or not yet open. Schedule it for your stage instead.'};
  if(/not eligible|allowlist|fee recipient.*not allowed/i.test(text))return {title:'You are not eligible to mint right now.',detail:'Try when your stage opens, or schedule it for your eligible window — you’ll get a notification.'};
  if(/not opened|not (currently )?active|not yet open|opens \d|opening time/i.test(text))return {title:'This mint is not open yet.',detail:'Check the opening time and try again later.'};
  if(/already closed|stage has already closed|mint has ended/i.test(text))return {title:'This mint has ended.',detail:'No transaction was sent.'};
  if(/incorrect payment|wrong price|requires exactly/i.test(text))return {title:'The mint price is incorrect.',detail:'Check the price and try again.'};
  if(code==='SIMULATION_FAILED')return {title:'This mint would fail.',detail:'Check the price, quantity, mint method, and opening time, then try again.'};
  return {title:'We could not preview this mint.',detail:'Check the contract details and try again.'};
}
