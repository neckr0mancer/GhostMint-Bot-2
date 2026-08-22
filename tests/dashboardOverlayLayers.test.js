const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const css=fs.readFileSync(path.join(__dirname,'..','dashboard','src','styles.css'),'utf8');
const appSource=fs.readFileSync(path.join(__dirname,'..','dashboard','src','App.jsx'),'utf8');

function zIndexFor(selector){
  const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const rule=css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(rule,`${selector} must have a CSS rule`);
  const zIndex=rule[1].match(/z-index\s*:\s*(\d+)/);
  assert.ok(zIndex,`${selector} must declare a numeric z-index`);
  return Number(zIndex[1]);
}

test('security review, notifications, and blocking confirmations have a usable layer order',()=>{
  const review=zIndexFor('.ovl-bd');
  const notifications=zIndexFor('.toast-host');
  const confirmation=zIndexFor('.confirm-modal-backdrop');

  assert.ok(notifications>review,'notifications must remain visible above a review overlay');
  assert.ok(confirmation>notifications,'blocking confirmation must be the topmost actionable layer');
});

test('an open overlay does not steal focus again when its contents rerender',()=>{
  const start=appSource.indexOf('function Overlay(');
  const end=appSource.indexOf('// ── Wallet details',start);
  assert.notEqual(start,-1,'App.jsx must declare the shared Overlay component');
  assert.notEqual(end,-1,'the shared Overlay component must remain independently testable');
  const overlay=appSource.slice(start,end);

  assert.match(overlay,/const onCloseRef=useRef\(onClose\)/,
    'the Escape handler must read the latest close callback without restarting the focus effect');
  assert.match(overlay,/\},\[open\]\);/,
    'the focus effect must run only when open state changes, not after every form keystroke');
  assert.doesNotMatch(overlay,/\},\[open,onClose\]\);/,
    'an inline onClose callback must not cause the panel to steal focus on every rerender');
});
