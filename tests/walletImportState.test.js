const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const root=path.join(__dirname,'..');

test('mixed import keeps only failed rows and removes successful secrets',async()=>{
  const {walletImportRetryRows}=await import('../dashboard/src/walletImportState.mjs');
  const rows=[
    {key:0,secret:'successful-secret-one',label:''},
    {key:1,secret:'retry-this-secret',label:''},
    {key:2,secret:'successful-secret-two',label:'Third'},
  ];
  const results=[
    {key:0,status:'success',label:'Primary'},
    {key:1,status:'failed',label:'Primary-2',error:'duplicate'},
    {key:2,status:'success',label:'Third'},
  ];

  const retryRows=walletImportRetryRows(rows,results);

  assert.deepEqual(retryRows,[{key:1,secret:'retry-this-secret',label:'Primary-2'}]);
  assert.doesNotMatch(JSON.stringify(retryRows),/successful-secret/);
});

test('Wallet import retries from the reduced failed-row state',()=>{
  const app=fs.readFileSync(path.join(root,'dashboard','src','App.jsx'),'utf8');
  const start=app.indexOf('async function importWallets(');
  const end=app.indexOf('\n  const title=',start);
  const importWallets=app.slice(start,end);

  assert.match(importWallets,/key:row\.key,index,secret:row\.secret\.trim\(\)/);
  assert.match(importWallets,/if\(ok<collected\.length\)setRows\(walletImportRetryRows\(rows,collected\)\)/);
});
