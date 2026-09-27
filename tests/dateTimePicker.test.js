const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const test=require('node:test');

const root=path.join(__dirname,'..');
const load=()=>import(pathToFileURL(path.join(root,'dashboard','src','dateTimePicker.mjs')).href);

test('local picker values round-trip with seconds intact',async()=>{
  const picker=await load();
  const parsed=picker.parseLocalDateTime('2026-09-27T05:04:09');
  assert.ok(parsed);
  assert.equal(picker.localDateTimeValue(parsed),'2026-09-27T05:04:09');
  assert.equal(picker.parseLocalDateTime('2026-02-29T05:04:09'),null);
  assert.ok(picker.parseLocalDateTime('2028-02-29T05:04:09'));
});
test('calendar months always expose six complete, contiguous weeks',async()=>{
  const picker=await load();
  const days=picker.calendarMonthDays(new Date(2026,8,1));
  assert.equal(days.length,42);
  assert.equal(days[0].getDay(),0);
  assert.equal(days[41].getDay(),6);
  for(let index=1;index<days.length;index+=1){
    const expected=picker.addCalendarDays(days[index-1],1);
    assert.equal(days[index].getFullYear(),expected.getFullYear());
    assert.equal(days[index].getMonth(),expected.getMonth());
    assert.equal(days[index].getDate(),expected.getDate());
  }
});

test('month movement clamps end-of-month dates without skipping a month',async()=>{
  const picker=await load();
  const january31=new Date(2028,0,31,11,22,33);
  const february=picker.addCalendarMonths(january31,1);
  assert.equal(february.getFullYear(),2028);
  assert.equal(february.getMonth(),1);
  assert.equal(february.getDate(),29);
  assert.equal(picker.localDateTimeValue(february).slice(11),'11:22:33');
});

test('minimum boundaries compare the whole instant but keep the minimum day selectable',async()=>{
  const picker=await load();
  const minimum=picker.parseLocalDateTime('2026-09-27T12:30:45');
  const earlierDay=new Date(2026,8,26,23,59,59);
  const sameDay=new Date(2026,8,27,0,0,0);
  assert.equal(picker.calendarDayBefore(earlierDay,minimum),true);
  assert.equal(picker.calendarDayBefore(sameDay,minimum),false);
  assert.equal(picker.localDateTimeValue(picker.clampLocalDateTime('2026-09-27T12:30:44',minimum)),
    '2026-09-27T12:30:45');
});

test('time composition rejects malformed or out-of-range fields',async()=>{
  const picker=await load();
  const day=new Date(2026,8,27);
  assert.equal(picker.combineLocalDateAndTime(day,{hour:'24',minute:'00',second:'00'}),null);
  assert.equal(picker.combineLocalDateAndTime(day,{hour:'12',minute:'60',second:'00'}),null);
  assert.equal(picker.localDateTimeValue(picker.combineLocalDateAndTime(day,{hour:'12',minute:'30',second:'05'})),
    '2026-09-27T12:30:05');
});

test('the reusable component contains dialog, grid, keyboard, and cancel/apply semantics',()=>{
  const source=fs.readFileSync(path.join(root,'dashboard','src','DateTimePicker.jsx'),'utf8');
  const css=fs.readFileSync(path.join(root,'dashboard','src','dateTimePicker.css'),'utf8');
  assert.match(source,/role="dialog" aria-modal="true"/);
  assert.match(source,/role="grid"/);
  for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Escape','Tab']){
    assert.match(source,new RegExp(`'${key}'`));
  }
  assert.match(source,/>Cancel<\/button>/);
  assert.match(source,/>Apply<\/button>/);
  assert.match(source,/if\(!active&&open\)setOpen\(false\)/,
    'an inactive mounted tab must close the picker and release its body scroll lock');
  assert.doesNotMatch(source,/type="datetime-local"/);
  assert.match(css,/@media\(min-width:701px\)[\s\S]*\.date-time-picker-dialog\{position:fixed;top:50%;left:50%/,
    'desktop uses a viewport-contained dialog instead of clipping below its field');
  assert.match(css,/@media\(max-width:700px\)[\s\S]*\.date-time-picker-dialog\{position:fixed;inset:auto 0 0/);
  assert.match(css,/var\(--surface\)/);
  assert.match(css,/var\(--accent\)/);
  assert.doesNotMatch(css,/#[0-9a-f]{3,8}/i,'theme colors must come from the existing token system');
});
