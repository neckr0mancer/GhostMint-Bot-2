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
  const text=String(error?.message||'');
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
  if(/sold out|max supply/i.test(text))return {title:'This mint is sold out.',detail:'No transaction was sent.'};
  if(/not opened|not active|opens \d|opening time/i.test(text))return {title:'This mint is not open yet.',detail:'Check the opening time and try again later.'};
  if(/already closed|stage has already closed|mint has ended/i.test(text))return {title:'This mint has ended.',detail:'No transaction was sent.'};
  if(/incorrect payment|wrong price|requires exactly/i.test(text))return {title:'The mint price is incorrect.',detail:'Check the price and try again.'};
  if(code==='SIMULATION_FAILED')return {title:'This mint would fail.',detail:'Check the price, quantity, mint method, and opening time, then try again.'};
  return {title:'We could not preview this mint.',detail:'Check the contract details and try again.'};
}
