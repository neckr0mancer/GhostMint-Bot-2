const test=require('node:test');
const assert=require('node:assert');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

const load=()=>import(pathToFileURL(path.join(__dirname,'..','dashboard','src','countdown.js')).href);

test('a short countdown visibly advances across its actual schedule window',async()=>{
  const {countdownState}=await load();
  const start=Date.UTC(2026,7,22,10,0,0);
  const target=start+10*60*1000;
  const halfway=countdownState(target,start,start+5*60*1000);
  const later=countdownState(target,start,start+7.5*60*1000);
  assert.equal(halfway.clock,'05:00');
  assert.equal(halfway.progress,0.5);
  assert.equal(later.clock,'02:30');
  assert.equal(later.progress,0.75);
});

test('long waits use days and hours instead of an unreadable five-digit hour counter',async()=>{
  const {countdownState}=await load();
  const now=Date.UTC(2026,7,22,10,0,0);
  const state=countdownState(now+(40*86400+6*3600)*1000,now,now);
  assert.equal(state.clock,'40d 6h');
  assert.equal(state.progress,0);
});
