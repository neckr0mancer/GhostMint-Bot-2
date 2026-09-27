const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const test=require('node:test');

const modulePromise=import(pathToFileURL(path.join(__dirname,'..','dashboard','src','themePreference.mjs')).href);

function memoryStorage(){
  const values=new Map();
  return {
    getItem:key=>values.has(key)?values.get(key):null,
    setItem:(key,value)=>values.set(key,String(value)),
    removeItem:key=>values.delete(key),
    values,
  };
}

test('pending dashboard themes are validated and isolated per account',async()=>{
  const {DASHBOARD_THEMES,isDashboardTheme,readPendingTheme,savePendingTheme}=await modulePromise;
  const storage=memoryStorage();
  assert.deepEqual(DASHBOARD_THEMES,[
    'ghost-mint','ghost-mint-light','clean-vault','neon-arcade','quiet-ledger',
  ]);
  assert.equal(isDashboardTheme('ghost-mint-light'),true);
  assert.equal(isDashboardTheme('system'),false);
  assert.equal(savePendingTheme('user-a','ghost-mint-light',storage),true);
  assert.equal(readPendingTheme('user-a',storage),'ghost-mint-light');
  assert.equal(readPendingTheme('user-b',storage),null);
  assert.equal(savePendingTheme('user-a','not-a-theme',storage),false);
  assert.equal(readPendingTheme('user-a',storage),'ghost-mint-light');
});

test('an unsynchronized local choice wins until the server catches up',async()=>{
  const {resolveDashboardTheme,savePendingTheme}=await modulePromise;
  const storage=memoryStorage();
  assert.equal(resolveDashboardTheme('user-a','ghost-mint-light',storage),'ghost-mint-light');
  assert.equal(savePendingTheme('user-a','ghost-mint',storage),true);
  assert.equal(resolveDashboardTheme('user-a','ghost-mint-light',storage),'ghost-mint');
  assert.equal(resolveDashboardTheme('user-b','unknown-theme',storage),'ghost-mint');
});

test('a completed request cannot clear a newer pending theme',async()=>{
  const {clearPendingTheme,readPendingTheme,savePendingTheme}=await modulePromise;
  const storage=memoryStorage();
  savePendingTheme('user-a','ghost-mint',storage);
  savePendingTheme('user-a','ghost-mint-light',storage);
  assert.equal(clearPendingTheme('user-a','ghost-mint',storage),false);
  assert.equal(readPendingTheme('user-a',storage),'ghost-mint-light');
  assert.equal(clearPendingTheme('user-a','ghost-mint-light',storage),true);
  assert.equal(readPendingTheme('user-a',storage),null);
});

test('disabled browser storage degrades to session-only theme behavior',async()=>{
  const {clearPendingTheme,readPendingTheme,resolveDashboardTheme,savePendingTheme}=await modulePromise;
  const storage={
    getItem(){throw new Error('storage disabled');},
    setItem(){throw new Error('storage disabled');},
    removeItem(){throw new Error('storage disabled');},
  };
  assert.equal(readPendingTheme('user-a',storage),null);
  assert.equal(savePendingTheme('user-a','ghost-mint-light',storage),false);
  assert.equal(clearPendingTheme('user-a','ghost-mint-light',storage),false);
  assert.equal(resolveDashboardTheme('user-a','ghost-mint-light',storage),'ghost-mint-light');
});
