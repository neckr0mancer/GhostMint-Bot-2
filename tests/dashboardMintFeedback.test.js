const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const {mintPriceStep}=require('../src/discord/menus');
const {pathToFileURL}=require('node:url');

const appSource=fs.readFileSync(path.join(__dirname,'..','dashboard','src','App.jsx'),'utf8');

test('dashboard address detection deduplicates overlapping paste and blur requests',()=>{
  assert.match(appSource,/requestKey===lastDetected\.current\|\|requestKey===detectingKey\.current/);
  assert.match(appSource,/detectingKey\.current=requestKey;[\s\S]*await api\(`\/api\/mints\/detect/);
});

test('dashboard waits for an unknown price instead of raising a red simulation error',()=>{
  assert.match(appSource,/\(!viaOpenSea&&priceEth===''\)\)return/);
  assert.match(appSource,/Mint price needed\.<\/b> Enter the price per NFT to continue/);
  assert.doesNotMatch(appSource,/Price \(ETH\) must be a plain non-negative number/);
});

test('notification bell records toast messages without rendering a second pop-up',()=>{
  assert.match(appSource,/subscribeNotificationLog\(setLog\)/);
  assert.doesNotMatch(appSource,/bell-auto-preview/);
});

test('Discord uses the same calm manual-price guidance',()=>{
  const payload=mintPriceStep({chainSym:'ETH'});
  assert.equal(payload.content,'Enter the mint price per item in ETH to continue. Use 0 only if the mint is free.');
  assert.equal(/recognized price function/i.test(payload.content),false);
});

test('mint preview turns insufficient balance diagnostics into a short actionable message',async()=>{
  const feedback=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintFeedback.mjs')));
  const result=feedback.mintPreviewError({code:'SIMULATION_FAILED',message:'This wallet cannot cover the mint price plus the network fee on robinhood (0xabc). Both are paid together.'},{chain:'robinhood',quantity:1});
  assert.deepEqual(result,{title:'Not enough ETH for this mint.',detail:'Fund this wallet or use another wallet with enough balance.'});
  assert.equal(JSON.stringify(result).includes('400'),false);
  assert.equal(JSON.stringify(result).includes('0xabc'),false);
});

test('mint preview only suggests lowering quantity when that is possible',async()=>{
  const {mintPreviewError}=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintFeedback.mjs')));
  const error={code:'INSUFFICIENT_BALANCE'};
  assert.equal(mintPreviewError(error,{chain:'ethereum',quantity:2}).detail,'Fund this wallet, use another wallet with enough balance, or lower the quantity.');
  assert.equal(mintPreviewError(error,{chain:'ethereum',quantity:1}).detail,'Fund this wallet or use another wallet with enough balance.');
  assert.equal(mintPreviewError({code:'VALUE_CEILING_EXCEEDED'},{quantity:1}).detail,'Increase the wallet limit before trying again.');
  assert.equal(mintPreviewError({code:'VALUE_CEILING_EXCEEDED'},{quantity:2}).detail,'Lower the quantity or increase the wallet limit.');
  assert.equal(mintPreviewError({code:'DAILY_BUDGET_EXCEEDED'},{quantity:1}).detail,'Wait for the limit to reset or use another wallet.');
  assert.equal(mintPreviewError({code:'DAILY_BUDGET_EXCEEDED'},{quantity:2}).detail,'Lower the quantity, wait for the limit to reset, or use another wallet.');
});

test('mint preview gives concise next steps for common safety failures',async()=>{
  const {mintPreviewError}=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintFeedback.mjs')));
  assert.deepEqual(mintPreviewError({code:'GAS_CEILING_EXCEEDED'},{chain:'robinhood'}),{title:'Gas is above your limit.',detail:'Raise the wallet gas limit before trying again.'});
  assert.deepEqual(mintPreviewError({code:'SIMULATION_FAILED',message:'execution reverted'},{chain:'robinhood'}),{title:'This mint would fail.',detail:'Check the price, quantity, mint method, and opening time, then try again.'});
});
