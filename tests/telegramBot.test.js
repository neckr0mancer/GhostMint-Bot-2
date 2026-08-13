const assert=require('node:assert/strict');
const test=require('node:test');

test('installed node-telegram-bot-api export provides an instantiable TelegramBot class',async t=>{
  const telegramModule=require('node-telegram-bot-api');
  assert.equal(typeof telegramModule,'object');
  assert.equal(typeof telegramModule.TelegramBot,'function');
  const bot=new telegramModule.TelegramBot('123456:test-token',{polling:false});
  t.after(()=>bot.stopPolling?.({cancel:true}).catch(()=>{}));
  assert.equal(typeof bot.onText,'function');
  assert.equal(typeof bot.sendMessage,'function');
  assert.equal(bot.isPolling(),false);
});
