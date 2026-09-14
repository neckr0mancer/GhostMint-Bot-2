const assert=require('node:assert/strict');
const test=require('node:test');

test('legacy preview payload derives gas and uses the target-chain wallet balance',async()=>{
  const {mintPreviewMetrics}=await import('../dashboard/src/mintPreviewMetrics.mjs');
  const metrics=mintPreviewMetrics({
    simulation:{estimatedCostWei:'2500000000000000',gasLimit:'21000',feePerGasWei:'100000000000'},
    preview:{nativeValueWei:'400000000000000'},chain:'robinhood',
    wallet:{chain:'ethereum',balances:[{chain:'ethereum',balance:'1'},{chain:'robinhood',balance:'0.003'}]},
  });
  assert.equal(metrics.estimatedGasWei,'2100000000000000');
  assert.equal(metrics.totalDebitWei,'2500000000000000');
  assert.equal(metrics.walletBalanceWei,'3000000000000000');
  assert.equal(metrics.balanceInsufficient,false);
});

test('current exact preview fields win and zero native value remains distinguishable as free',async()=>{
  const {mintPreviewMetrics}=await import('../dashboard/src/mintPreviewMetrics.mjs');
  const metrics=mintPreviewMetrics({simulation:{balanceWei:'10',estimatedGasCostWei:'3',estimatedCostWei:'3',gasLimit:'99',feePerGasWei:'99'},preview:{nativeValueWei:'0'}});
  assert.deepEqual(metrics,{nativeValueWei:'0',estimatedGasWei:'3',totalDebitWei:'3',walletBalanceWei:'10',balanceInsufficient:false});
});

test('unknown preview values stay unknown instead of becoming false zeroes',async()=>{
  const {mintPreviewMetrics}=await import('../dashboard/src/mintPreviewMetrics.mjs');
  assert.deepEqual(mintPreviewMetrics({}),{nativeValueWei:null,estimatedGasWei:null,totalDebitWei:null,walletBalanceWei:null,balanceInsufficient:false});
});
