const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');

const root=path.join(__dirname,'..');

test('first export uses the newly created security password in the same attempt',async()=>{
  const {resolveWalletExportPassword}=await import('../dashboard/src/walletExportFlow.mjs');
  let setups=0;
  const password=await resolveWalletExportPassword({
    securityPasswordSet:false,
    enteredPassword:undefined,
    setupPassword:async()=>{setups+=1;return 'new-password';},
  });
  assert.equal(password,'new-password');
  assert.equal(setups,1);
});

test('existing-password export does not run setup',async()=>{
  const {resolveWalletExportPassword}=await import('../dashboard/src/walletExportFlow.mjs');
  let setups=0;
  const password=await resolveWalletExportPassword({
    securityPasswordSet:true,
    enteredPassword:'existing-password',
    setupPassword:async()=>{setups+=1;return 'unused';},
  });
  assert.equal(password,'existing-password');
  assert.equal(setups,0);
});

test('Wallet Export makes password setup reachable before requiring an existing password',()=>{
  const app=fs.readFileSync(path.join(root,'dashboard','src','App.jsx'),'utf8');
  const start=app.indexOf('function WalletExport(');
  const end=app.indexOf('\nfunction WalletsPage(',start);
  const walletExport=app.slice(start,end);
  assert.match(walletExport,/const securityPassword=await resolveWalletExportPassword/);
  assert.match(walletExport,/body:JSON\.stringify\(\{securityPassword,/);
  assert.match(walletExport,/profile\.securityPasswordSet&&<label className="fl"><span>Security password<\/span>/);
  assert.match(walletExport,/Set password and continue/);
});
