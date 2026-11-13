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

test('shared overlays isolate the modal branch without disabling their scrim',()=>{
  const start=appSource.indexOf('function Overlay(');
  const end=appSource.indexOf('// ── Wallet details',start);
  assert.notEqual(start,-1,'App.jsx must declare the shared Overlay component');
  assert.notEqual(end,-1,'the shared Overlay component must remain independently testable');
  const overlay=appSource.slice(start,end);

  assert.match(overlay,/const layerRef=useRef\(null\)/);
  assert.match(overlay,/useModalAccessibility\(open,layerRef,\{onClose,initialFocusRef:panelRef,closeDisabled:busy\}\)/,
    'the shared hook must own focus containment, background inertness, Escape, scroll lock, and focus restoration');
  assert.match(overlay,/<div ref=\{layerRef\} className="ovl-bd"/,
    'the active branch must include both the dialog and its clickable scrim');
  assert.match(overlay,/event\.target===event\.currentTarget&&!busy/,
    'the scrim must close only while the overlay is not busy');
  assert.match(overlay,/aria-label="Close" disabled=\{busy\}/,
    'the explicit close control must share the consequential-request lock');
  assert.doesNotMatch(overlay,/document\.addEventListener\('keydown'|document\.body\.style\.overflow|onCloseRef|busyRef/,
    'Overlay must not install a second competing keyboard or scroll-lock effect');
});
