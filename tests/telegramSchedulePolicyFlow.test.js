const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');

test('Telegram schedule confirmation wires both policy controls into the shared task input',()=>{
  assert.match(source,/flow:taskautotime:toggle/);
  assert.match(source,/flow:taskpricecap:ask/);
  assert.match(source,/setPriceCap\(flow\.data,value\)/);
  assert.match(source,/\.\.\.taskPolicyInput\(flowData\)/);
  assert.match(source,/toggleAutoReschedule\(flow\.data\)/);
  assert.match(source,/clearPriceCap\(flow\.data\)/);
});

test('Telegram schedule-change buttons resolve the same versioned command-service state',()=>{
  assert.match(source,/\^task:chg:\(a\|q\|c\):\(\\d\+\):/);
  assert.match(source,/botCommands\.resolveTaskChange\(userId,id,\{decision,version:Number\(versionText\)\}\)/);
  assert.match(source,/Open Tasks in Telegram\/Discord, or Schedule details on the dashboard/);
});
