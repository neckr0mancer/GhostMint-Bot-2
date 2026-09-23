'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');

test('Telegram direct scheduling requests and consumes the shared provider stage plan',()=>{
  const start=source.indexOf('async function startTaskScheduleFlow');
  const end=source.indexOf('async function advanceFromTaskDetails',start);
  const block=source.slice(start,end);
  assert.match(block,/detectMintContract\(userId, \{ contractAddress, quantity: 1, includeDrop: true \}\)/);
  assert.match(block,/schedulePlan: detected\.schedulePlan/);
  assert.match(block,/afterScheduleViaOpenSeaTap\([\s\S]*schedulePlan: data\.schedulePlan/);
  assert.match(block,/buildOpenSeaScheduleTaskData\(data, plannedStage\)/);
});

test('Telegram guided scheduling keeps manual phase callbacks and adds one server-recommended action',()=>{
  assert.match(source,/data === 'flow:scheduleviaopensea'[\s\S]{0,500}gateBlocks\(\{ chatId, messageId, userId, action: 'schedule' \}\)/);
  assert.match(source,/refreshTelegramOpenSeaScheduleData\(userId,flow\.data\)/);
  assert.match(source,/data === 'flow:scheduleviaopenseaauto'/);
  assert.match(source,/drop:refreshed\.drop,schedulePlan:refreshed\.schedulePlan/);
  assert.match(source,/data\.startsWith\('flow:scheduleviaopenseaphase:'\)/);
  assert.match(source,/schedulePlan: detected\.schedulePlan/);
});
