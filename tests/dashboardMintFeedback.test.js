const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const {mintPriceStep}=require('../src/discord/menus');

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
