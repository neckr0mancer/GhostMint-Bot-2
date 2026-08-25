const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const root=path.join(__dirname,'..');
const home=fs.readFileSync(path.join(root,'dashboard','src','dashboardWidgets','home.jsx'),'utf8');
const shared=fs.readFileSync(path.join(root,'dashboard','src','shared.jsx'),'utf8');
const styles=fs.readFileSync(path.join(root,'dashboard','src','styles.css'),'utf8');
const prototype=fs.readFileSync(path.join(root,'dashboard','src','prototype.css'),'utf8');
const {createPostgresStorage}=require('../src/storage/postgresStorage');

test('the post-mint celebration uses the prototype reward-panel structure',()=>{
  assert.match(shared,/className="cel"/);
  assert.match(shared,/className="cel-b"/);
  assert.match(shared,/<h3>\{title\}<\/h3>/);
  assert.match(shared,/M5 13l4 4L19 7/);
  assert.match(prototype,/\.cel\{background:radial-gradient/);
  assert.match(prototype,/\.cel-b\{/);
  assert.match(prototype,/\.app\[data-m\] \.cel\{/);
  assert.doesNotMatch(styles,/(?:^|\n)\.celebrate\{/);
  assert.doesNotMatch(styles,/(?:^|\n)\.streak\{/);
  assert.match(styles,/\.celebrate-actions\{justify-content:center;margin-top:13px\}/);
});

test('the celebration keeps real activity data and a chain-neutral transaction action',()=>{
  assert.match(home,/mintRewardSubject\(item\)/);
  assert.match(home,/item\.walletLabel/);
  assert.match(home,/item\.transactionValueWei/);
  assert.match(home,/item\.tokenIds/);
  assert.match(home,/explorer&&item\.txHash/);
  assert.match(home,/className="b sm"[\s\S]*explorerName\(explorer\)/);
  assert.doesNotMatch(home,/Azuki Elementals|4s after open|0\.08/);
});

test('Dismiss persists only the current celebration until a newer activity key arrives',()=>{
  assert.match(home,/useState\(\(\)=>readDismissedReward\('home'\)\)/);
  assert.match(home,/visible:Boolean\(summary\.latestSuccess\)/);
  assert.match(home,/onClick=\{\(\)=>onDismiss\(itemKey\)\}>Dismiss<\/button>/);
  assert.match(home,/saveDismissedReward\('home',key\)/);
  assert.match(shared,/const DISMISSED_REWARDS_FIELD='dismissedRewards'/);
  assert.match(shared,/\[DISMISSED_REWARDS_FIELD\]:\{\.\.\.saved,\[scope\]:String\(itemKey\)\}/);
  assert.match(shared,/Reset means layout order only/);
  assert.doesNotMatch(home,/>All activity<\/button>/);
});

test('the explorer action has no link underline and every reward has truthful context',()=>{
  assert.match(styles,/\.celebrate-actions a,\.celebrate-actions a:hover\{text-decoration:none\}/);
  assert.match(home,/streak>=2\)return `🔥 \$\{streak\} confirmed in a row`/);
  assert.match(home,/return '✓ Mint confirmed on-chain'/);
  assert.match(home,/<div className="streak">\{mintRewardContext\(item,summary\.streak\)\}<\/div>/);
  assert.doesNotMatch(home,/🔥 6 in a row/);
});

test('Home implements the prototype reorder handles as real persisted and keyboard-accessible controls',()=>{
  assert.match(home,/ReorderableStack stackKey="home-left"/);
  assert.match(home,/ReorderableStack stackKey="home-right"/);
  assert.match(shared,/const SECTION_ORDER_KEY='ghostmint-section-order'/);
  assert.match(shared,/className="dragh" draggable="true"/);
  assert.match(shared,/event\.key==='ArrowUp'\|\|event\.key==='ArrowDown'/);
  assert.match(shared,/data-reorder=\{stackKey\}/);
  assert.match(shared,/saveSectionOrder\(stackKey,next\)/);
  assert.match(shared,/resetSectionOrders/);
  assert.match(prototype,/\.dragh\{/);
});

test('Home follows the prototype mobile collapse defaults without collapsing desktop content',()=>{
  assert.match(home,/title="P&L by day"[\s\S]*mobileCollapsible mobileDefaultOpen=\{false\}/);
  assert.match(home,/title="Recent activity"[\s\S]*mobileCollapsible mobileDefaultOpen/);
  assert.match(home,/title="Wallets"[\s\S]*mobileCollapsible mobileDefaultOpen=\{false\}/);
  assert.match(shared,/aria-expanded=\{open\}/);
  assert.match(shared,/className="colh"/);
  assert.match(shared,/className=\{mobileCollapsible\?'colb':undefined\}/);
  assert.match(prototype,/\.app\[data-m\] \.col\[data-open="0"\]>\.colb\{display:none\}/);
});

test('activity rows expose real transaction value, contract and token IDs for the reward copy',async()=>{
  const queries=[];
  const pool={query:async sql=>{queries.push(sql);if(sql.includes('COUNT(*)'))return {rows:[{total:1}]};
    return {rows:[{id:1,user_id:'user-a',status:'success',title:'Minted 1 NFT',wallet_label:'Trading',
      tx_hash:'0xabc',explorer:'https://robinhoodchain.blockscout.com/tx/',occurred_at:new Date(),
      actual_network_cost_wei:null,trigger_source:'manual',verification_state:null,address:null,
      transaction_chain:'robinhood',transaction_address:'0x'+'a'.repeat(40),transaction_value_wei:'80000000000000000',
      transaction_token_ids:['3821'],transaction_trigger_source:'manual',collection_name:'Real Collection'}]};}};
  const page=await createPostgresStorage(pool).listActivityPage('user-a',{limit:5,offset:0});
  assert.equal(page.items[0].transactionValueWei,80000000000000000n);
  assert.deepEqual(page.items[0].tokenIds,['3821']);
  assert.equal(page.items[0].address,'0x'+'a'.repeat(40));
  assert.equal(page.items[0].collectionName,'Real Collection');
  assert.match(queries[0],/transaction_intents\.value_wei AS transaction_value_wei/);
  assert.match(queries[0],/transaction_intents\.token_ids AS transaction_token_ids/);
  assert.match(queries[0],/contract_value_cache\.opensea_name AS collection_name/);
  assert.match(queries[0],/call_preview->>'contractAddress'/);
});
