const assert=require('node:assert/strict');
const test=require('node:test');

test('wallet headline follows the funded preferred EVM chain instead of a zero legacy home',async()=>{
  const {selectWalletHeadlineBalance,walletFundingStatus}=await import('../dashboard/src/walletDisplay.mjs');
  const wallet={chain:'ethereum',balances:[
    {chain:'ethereum',balance:'0',symbol:'ETH'},
    {chain:'robinhood',balance:'0.000182',symbol:'ETH'},
  ]};
  assert.equal(selectWalletHeadlineBalance(wallet,'robinhood').chain,'robinhood');
  assert.equal(walletFundingStatus(wallet,{preferredChain:'robinhood',lowThreshold:'0.0001'}).label,'Funded');
  assert.equal(walletFundingStatus(wallet,{preferredChain:'robinhood',lowThreshold:'0.0005'}).label,'Low');
});

test('strict chain balance lookup never substitutes funds from another network',async()=>{
  const {walletBalanceForChain}=await import('../dashboard/src/walletDisplay.mjs');
  const wallet={balances:[{chain:'ethereum',balance:'1'},{chain:'robinhood',balance:'0'}]};
  assert.equal(walletBalanceForChain(wallet,'robinhood').balance,'0');
  assert.equal(walletBalanceForChain(wallet,'base'),null);
});
