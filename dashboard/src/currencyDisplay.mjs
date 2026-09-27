export const DISPLAY_CURRENCY_OPTIONS=Object.freeze([
  {value:'USD',label:'US dollar',symbol:'$'},
  {value:'NGN',label:'Nigerian naira',symbol:'₦'},
  {value:'EUR',label:'Euro',symbol:'€'},
  {value:'GBP',label:'British pound',symbol:'£'},
  {value:'CAD',label:'Canadian dollar',symbol:'CA$'},
  {value:'AUD',label:'Australian dollar',symbol:'A$'},
]);

function finite(value){const number=Number(value);return Number.isFinite(number)?number:null;}

export function quoteFor(quotes,symbol,expectedCurrency){
  const quote=quotes?.quotes?.[String(symbol||'').toUpperCase()]??null;
  const responseCurrency=String(quotes?.displayCurrency||'').toUpperCase();
  const quoteCurrency=String(quote?.currency||'').toUpperCase();
  if(responseCurrency&&quoteCurrency&&responseCurrency!==quoteCurrency)return null;
  if(expectedCurrency&&quoteCurrency!==String(expectedCurrency).toUpperCase())return null;
  return quote&&quoteCurrency&&finite(quote.rate)>0?quote:null;
}

export function formatFiatValue(value,currency='USD'){
  const amount=finite(value);
  if(amount===null)return null;
  const absolute=Math.abs(amount);
  const maximumFractionDigits=absolute===0||absolute>=1?2:absolute>=0.01?4:6;
  return new Intl.NumberFormat(undefined,{style:'currency',currency,
    minimumFractionDigits:absolute===0?2:0,maximumFractionDigits}).format(amount);
}

export function fiatFromNative(nativeAmount,symbol,quotes,expectedCurrency){
  const amount=finite(nativeAmount);const quote=quoteFor(quotes,symbol,expectedCurrency);
  if(amount===null||!quote)return null;
  return {text:formatFiatValue(amount*quote.rate,quote.currency),quote};
}

export function fiatFromWei(wei,symbol,quotes,expectedCurrency){
  if(wei===null||wei===undefined)return null;
  try{
    const value=BigInt(wei);const whole=value/10n**18n;const fraction=value%10n**18n;
    return fiatFromNative(`${whole}.${fraction.toString().padStart(18,'0')}`,symbol,quotes,expectedCurrency);
  }catch{return null;}
}

function decimalRatio(value){
  const raw=String(value??'').trim();
  if(raw.length>80)return null;
  const match=/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(raw);
  if(!match)return null;
  const digits=`${match[1]}${match[2]||''}`.replace(/^0+(?=\d)/,'')||'0';
  const exponent=Number(match[3]||0);
  if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>36)return null;
  const scale=(match[2]?.length||0)-exponent;
  if(!Number.isSafeInteger(scale)||Math.abs(scale)>36)return null;
  try{
    if(scale>=0)return {numerator:BigInt(digits),denominator:10n**BigInt(scale)};
    return {numerator:BigInt(digits)*10n**BigInt(-scale),denominator:1n};
  }catch{return null;}
}

// Convert a display-only fiat allowance into one exact wei increment at scheduling time. The
// resulting wei cap is what the backend stores and enforces; later FX changes can never move it.
// Division deliberately rounds down so conversion can never authorize even one wei more than the
// user's stated fiat maximum.
export function schedulePriceCapWei({baselineWei='0',allowedIncreaseFiat,quote}){
  let baseline;
  try{baseline=BigInt(baselineWei??0);}catch{return null;}
  const fiat=decimalRatio(allowedIncreaseFiat);const rate=decimalRatio(quote?.rate);
  if(!fiat||!rate||fiat.numerator<0n||rate.numerator<=0n)return null;
  const increment=(fiat.numerator*rate.denominator*10n**18n)/
    (fiat.denominator*rate.numerator);
  return baseline+increment;
}
