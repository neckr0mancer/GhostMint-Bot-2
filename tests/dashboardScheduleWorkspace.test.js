const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const test=require('node:test');

const root=path.join(__dirname,'..');
const app=fs.readFileSync(path.join(root,'dashboard','src','App.jsx'),'utf8');
const css=fs.readFileSync(path.join(root,'dashboard','src','styles.css'),'utf8');

test('scheduled timestamps are readable and countdowns retain useful precision',async()=>{
  const display=await import(pathToFileURL(path.join(root,'dashboard','src','scheduleDisplay.js')));
  const at=new Date('2026-08-26T20:00:00.000Z');
  assert.equal(display.formatScheduleDateTime(at),'26 Aug 2026 · 20:00 UTC');
  assert.doesNotMatch(display.formatScheduleDateTime(at),/\dT\d|\.000Z|Z$/);
  assert.equal(display.scheduleCountdown(at,new Date('2026-08-26T18:33:00.000Z').getTime()),'1h 27m');
  assert.equal(display.scheduleCountdown(at,new Date('2026-08-25T17:00:00.000Z').getTime()),'1d 3h');
  assert.equal(display.scheduleCountdown(at,new Date('2026-08-26T20:01:00.000Z').getTime()),'');
});

test('Schedule exposes its countdown and readable metadata on mobile',()=>{
  assert.match(app,/function rowCountdown\(task\)/);
  assert.match(app,/formatScheduleDateTime\(at\)/);
  assert.match(app,/className="rv schedule-row-right">\{rowCountdown\(task\)\}\{rowPill\(task\)\}/);
  assert.match(css,/\.app\[data-m\] \.schedule-list-card \.rs\.fold\{display:block/);
  assert.match(css,/\.app\[data-m\] \.schedule-countdown/);
});

test('Mint tabs and page changes preserve drafts and in-flight detection',()=>{
  for(const tab of ['now','schedule','batch','presets'])assert.match(app,new RegExp(`hidden=\\{active!==['"]${tab}['"]\\}`));
  assert.match(app,/const \[mintWorkspaceMounted,setMintWorkspaceMounted\]=useState/);
  assert.match(app,/hidden=\{page!=='Mint'\}/);
  assert.match(app,/ContractLookupStatus visible=\{detecting\}/g);
  assert.match(app,/\(detecting\|\|simulating\)&&<div aria-label=/);
  assert.match(app,/busy\|\|detecting\|\|\(!walletsArrived/);
});
