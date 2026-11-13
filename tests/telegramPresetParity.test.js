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

test('Telegram mint-preset writes use the shared command service that refreshes the dashboard',()=>{
  const save=commandBlock("bot.onText(/^\\/mintpreset(?:@\\w+)?\\s+save",
    "bot.onText(/^\\/mintpreset(?:@\\w+)?\\s+use");
  assert.match(save,/botCommands\.saveMintPreset\(userId,payload\)/);
  assert.doesNotMatch(save,/mintService\.savePreset/);

  const remove=commandBlock("bot.onText(/^\\/mintpreset(?:@\\w+)?\\s+delete",
    "bot.onText(/^\\/mintpresets");
  assert.match(remove,/botCommands\.deleteMintPreset\(userId,match\[1\]\)/);
  assert.doesNotMatch(remove,/mintService\.deletePreset/);
});

test('Telegram direct and preset mints use the shared confirmed-mint accounting path',()=>{
  const direct=source.slice(source.indexOf('async function runFlexibleMint'),
    source.indexOf("bot.onText(/^\\/mintcall",source.indexOf('async function runFlexibleMint')));
  assert.match(direct,/recordMintActivitySafely\(\{ userId, wallet, quantity, intent,\s*chain: payload\.chain \|\| wallet\.chain \}\)/);
  assert.doesNotMatch(direct,/storage\.updateWalletMinted/);
  assert.doesNotMatch(direct,/logActivity\(/);

  const preset=commandBlock("bot.onText(/^\\/mintpreset(?:@\\w+)?\\s+use",
    "bot.onText(/^\\/mintpreset(?:@\\w+)?\\s+delete");
  assert.match(preset,/recordMintActivitySafely\(\{ userId, wallet, quantity, intent, chain: prepared\.chain \}\)/);
  assert.doesNotMatch(preset,/storage\.updateWalletMinted/);
  assert.doesNotMatch(preset,/logActivity\(/);
});

test('Telegram target-policy reset sends the validated object shape through the shared command service',()=>{
  const reset=commandBlock("bot.onText(/^\\/targetpolicy(?:@\\w+)?\\s+reset",
    "bot.onText(/^\\/targetpolicy(?:@\\w+)?\\s+bypass");
  assert.match(reset,/botCommands\.resetTargetPolicy\(userId,\{\s*targetType:match\[1\],targetId:match\[2\],\s*\}\)/);
  assert.doesNotMatch(reset,/resetTargetPolicy\(userId,match\[1\],match\[2\]\)/);
});

test('Telegram sniper removal uses a tap confirmation and the shared command service',()=>{
  const remove=commandBlock("bot.onText(/^\\/removesniper",
    "bot.onText(/^\\/wallets");
  assert.match(remove,/botCommands\.snipers\(userId\)\.find\(item => item\.id === id\)/);
  assert.match(remove,/setPendingConfirmation\(msg\.chat\.id, async \(\) =>/);
  assert.match(remove,/botCommands\.removeSniper\(userId, id\)/);
  assert.match(remove,/replyMarkup: confirmationKeyboard\(\)/);
});
