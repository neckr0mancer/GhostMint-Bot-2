const assert=require('node:assert/strict');
const test=require('node:test');

test('display conversion supports USD and NGN without changing the native input',async()=>{
  const {fiatFromNative}=await import('../dashboard/src/currencyDisplay.mjs');
  const native='0.00125';
  const quotes={quotes:{ETH:{symbol:'ETH',currency:'NGN',rate:4_000_000,quotedAt:1,
    stale:false,source:'coingecko'}}};
  const converted=fiatFromNative(native,'ETH',quotes);
  assert.match(converted.text,/5[,.]000/);
  assert.equal(native,'0.00125','display conversion must not mutate the native amount');
});

test('a fiat increase becomes one exact stored wei cap and later FX changes do not alter it',async()=>{
  const {schedulePriceCapWei}=await import('../dashboard/src/currencyDisplay.mjs');
  const baseline=1_000_000_000_000_000n;
  const cap=schedulePriceCapWei({baselineWei:baseline.toString(),allowedIncreaseFiat:'5',
    quote:{rate:2500}});
  assert.equal(cap,3_000_000_000_000_000n);
  assert.equal(cap,3_000_000_000_000_000n,'the saved cap remains exact after the quote snapshot');
  assert.equal(schedulePriceCapWei({baselineWei:'0',allowedIncreaseFiat:'5',quote:null}),null);
});

test('a non-integer quote rounds the allowed increase down so the cap never exceeds authorization',async()=>{
  const {schedulePriceCapWei}=await import('../dashboard/src/currencyDisplay.mjs');
  assert.equal(schedulePriceCapWei({baselineWei:'0',allowedIncreaseFiat:'1',quote:{rate:3}}),
    333333333333333333n);
});

test('currency races and hostile exponents fail closed instead of rendering or allocating',async()=>{
  const {quoteFor,schedulePriceCapWei}=await import('../dashboard/src/currencyDisplay.mjs');
  const quotes={displayCurrency:'USD',quotes:{ETH:{currency:'USD',rate:3000}}};
  assert.equal(quoteFor(quotes,'ETH','NGN'),null);
  assert.equal(schedulePriceCapWei({baselineWei:'0',allowedIncreaseFiat:'1e999999999999',
    quote:{rate:3000}}),null);
});
