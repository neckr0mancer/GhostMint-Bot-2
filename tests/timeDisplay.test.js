const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const test=require('node:test');

const root=path.join(__dirname,'..');
const load=()=>import(pathToFileURL(path.join(root,'dashboard','src','timeDisplay.mjs')).href);

test('dashboard time preference changes the clock convention, not the instant',async()=>{
  const display=await load();
  const at=new Date('2026-08-26T20:04:09.000Z');
  const twelve=display.formatDashboardDateTime(at,{timeFormat:'12h',locale:'en-US',timeZone:'UTC'});
  const twentyFour=display.formatDashboardDateTime(at,{timeFormat:'24h',locale:'en-US',timeZone:'UTC'});
  assert.match(twelve,/8:04 PM/);
  assert.match(twentyFour,/20:04/);
  assert.match(twelve,/Aug 26, 2026/);
  assert.match(twentyFour,/Aug 26, 2026/);
});

test('dashboard time formatting has safe defaults and invalid fallback',async()=>{
  const display=await load();
  assert.equal(display.normalizeTimeFormat('unexpected'),'24h');
  assert.equal(display.formatDashboardDateTime('not-a-date',{fallback:'Unavailable'}),'Unavailable');
});
