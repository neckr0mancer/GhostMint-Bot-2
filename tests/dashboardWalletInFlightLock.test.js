const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const app=fs.readFileSync(path.join(__dirname,'..','dashboard','src','App.jsx'),'utf8');

test('shared overlay blocks Escape, backdrop, and Close while busy',()=>{
  const start=app.indexOf('function Overlay(');
  const end=app.indexOf('\n// ── Wallet details',start);
  const overlay=app.slice(start,end);

  assert.match(overlay,/closeDisabled:busy/);
  assert.match(overlay,/event\.target===event\.currentTarget&&!busy/);
  assert.match(overlay,/aria-label="Close" disabled=\{busy\}/);
});

test('add-wallet create and import lock every dismissal control while saving',()=>{
  const start=app.indexOf('function NewWalletOverlay(');
  const end=app.indexOf('\nfunction Wallets(',start);
  const walletOverlay=app.slice(start,end);

  assert.match(walletOverlay,/<Overlay open=\{open\} onClose=\{close\} title=\{title\} busy=\{busy\}/);
  const lockedBackButtons=walletOverlay.match(/disabled=\{busy\} onClick=\{\(\)=>setMode\(null\)\}>Back<\/button>/g)||[];
  assert.equal(lockedBackButtons.length,2,'both Create and Import Back buttons must be locked');
});
