const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'dashboard','src','App.jsx'),'utf8');
const shared=fs.readFileSync(path.join(root,'dashboard','src','shared.jsx'),'utf8');
const styles=fs.readFileSync(path.join(root,'dashboard','src','styles.css'),'utf8');

function sourceBetween(startMarker,endMarker){
  const start=app.indexOf(startMarker);
  const end=app.indexOf(endMarker,start);
  assert.notEqual(start,-1,`${startMarker} must exist`);
  assert.notEqual(end,-1,`${endMarker} must follow ${startMarker}`);
  return app.slice(start,end);
}

const userShell=sourceBetween('function Shell(','function AdminDenied(');
const userSheet=sourceBetween('function MoreSheet(','function automationBadges(');
const adminSheet=sourceBetween('function AdminMoreSheet(','function ScrollTop(');
const adminShell=sourceBetween('function AdminShell(','function isAdminPath(');

test('user and Admin shells expose the same persistent More-open state to CSS',()=>{
  assert.match(userShell,/if\(isRail\)return <div className=\{`app\$\{moreOpen\?' more-open':''\}`\}/);
  assert.match(adminShell,/className=\{`app admin-app\$\{moreOpen\?' more-open':''\}`\}/);
  assert.match(userShell,/<MoreSheet open=\{moreOpen\}/);
  assert.match(adminShell,/<AdminMoreSheet open=\{moreOpen\}/);
});

test('an open More surface stays visible as a centered modal above the mobile breakpoint',()=>{
  const marker='/* Keep an open More surface actionable across the shared 700px breakpoint.';
  const start=styles.indexOf(marker);
  const end=styles.indexOf('/* ==========================================================================\n   Login page',start);
  assert.notEqual(start,-1,'the cross-breakpoint More treatment must be documented and scoped');
  assert.notEqual(end,-1,'the desktop More treatment must remain independently inspectable');
  const desktop=styles.slice(start,end);

  assert.match(desktop,/@media screen and \(min-width:701px\)/);
  assert.match(desktop,/:where\(html\[data-theme="ghost-mint"\],html\[data-theme="ghost-mint-light"\]\) \.app\.more-open \.sheet-backdrop\{[\s\S]*?display:block;position:fixed;inset:0/);
  assert.match(desktop,/:where\(html\[data-theme="ghost-mint"\],html\[data-theme="ghost-mint-light"\]\) \.app\.more-open \.more-sheet\{[\s\S]*?display:flex;[\s\S]*?top:50%;left:50%;right:auto;bottom:auto;[\s\S]*?transform:translate\(-50%,-50%\)/);
  assert.match(desktop,/width:min\(32rem,calc\(100vw - 2rem\)\);max-height:min\(80vh,42rem\);overflow:auto/);
  assert.doesNotMatch(desktop,/\.app\.more-open \.more-sheet\{[^}]*display:none/);
});

test('resizing does not auto-close either open sheet',()=>{
  for(const source of [userShell,adminShell]){
    assert.doesNotMatch(source,/useEffect\([\s\S]{0,240}setMoreOpen\(false\)[\s\S]{0,160}\[mobile\]/,
      'a viewport change is incidental and must not dismiss an already-open navigation surface');
  }
});

test('both sheets retain shared Escape, focus containment, and focus restoration behavior',()=>{
  for(const source of [userSheet,adminSheet]){
    assert.match(source,/useModalAccessibility\(open,layerRef,\{onClose,initialFocusRef:closeRef,restoreFocusFallback\}\)/);
    assert.match(source,/if\(!open\)return null/);
    assert.match(source,/className="sheet-backdrop" onClick=\{onClose\}/);
  }
  assert.match(shared,/if\(event\.key==='Escape'&&!closeDisabledRef\.current\)\{event\.preventDefault\(\);onCloseRef\.current\?\.\(\);return;\}/);
  assert.match(shared,/restoreModalFocus\(previouslyFocused,fallback\)/);
});

test('both shells supply a visible desktop rail fallback without closing on resize',()=>{
  assert.match(userShell,/const desktopRailFallbackRef=useRef\(null\)/);
  assert.match(userShell,/ref=\{page===item\?desktopRailFallbackRef:undefined\}/);
  assert.match(userShell,/restoreFocusFallback=\{\(\)=>desktopRailFallbackRef\.current\}/);
  assert.match(adminShell,/const desktopRailFallbackRef=useRef\(null\)/);
  assert.match(adminShell,/<a ref=\{desktopRailFallbackRef\} className="nav" href="\/dashboard\/">/);
  assert.match(adminShell,/restoreFocusFallback=\{\(\)=>desktopRailFallbackRef\.current\}/);
});
