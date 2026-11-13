const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const source=fs.readFileSync(path.join(__dirname,'..','src','server.js'),'utf8');

function commandBlock(start,end){
  const from=source.indexOf(start);
  const to=source.indexOf(end,from+start.length);
  assert.notEqual(from,-1,`missing Telegram handler: ${start}`);
  assert.notEqual(to,-1,`missing following Telegram handler: ${end}`);
  return source.slice(from,to);
}

test('Telegram registers P&L and lists the linked account through the shared pager',()=>{
  assert.match(source,/\{ command: 'pnl', description: 'View or update your P&L records' \}/);
  const list=commandBlock("bot.onText(/^\\/pnl(?:@\\w+)?(?:\\s+list)?",
    "bot.onText(/^\\/pnl(?:@\\w+)?\\s+add");
  assert.match(list,/botCommands\.pnlPage\(userId, \{ page:match\[1\] \|\| 1 \}\)/);
  assert.match(list,/escapeTelegramHtml\(record\.nm\)/);
});

test('Telegram manual add and sale-only update use shared account-scoped commands',()=>{
  const add=commandBlock("bot.onText(/^\\/pnl(?:@\\w+)?\\s+add",
    "bot.onText(/^\\/pnl(?:@\\w+)?\\s+sale");
  assert.match(add,/commandRateLimiter\.check\('telegram',userId,'pnl'\)/);
  assert.match(add,/botCommands\.addPnl\(userId,commandJson\(match\[1\]\)\)/);

  const sale=commandBlock("bot.onText(/^\\/pnl(?:@\\w+)?\\s+sale",
    "bot.onText(/^\\/gas");
  assert.match(sale,/commandRateLimiter\.check\('telegram',userId,'pnl'\)/);
  assert.match(sale,/botCommands\.recordPnlSale\(userId,match\[1\],\{sale:match\[2\]\}\)/);
  assert.doesNotMatch(sale,/updatePnl/);
  assert.doesNotMatch(sale,/deletePnl/);
});
