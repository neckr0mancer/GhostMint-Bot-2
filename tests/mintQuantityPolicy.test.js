const assert=require('node:assert/strict');
const test=require('node:test');
const {pathToFileURL}=require('node:url');
const path=require('node:path');

async function policy(result){
  const module=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintQuantityPolicy.mjs')));
  return module.mintQuantityPolicy(result);
}

test('top-level contract max is authoritative over conflicting nested OpenSea stage metadata',async()=>{
  assert.deepEqual(await policy({maxPerWallet:100,drop:{activeStage:{maxPerWallet:1}}}),{max:100,detected:true});
});

test('an unknown contract max falls back to the validated application ceiling',async()=>{
  assert.deepEqual(await policy({maxPerWallet:null}),{max:100,detected:false});
});

test('quantity policy normalizes strings and never exceeds the application ceiling',async()=>{
  assert.deepEqual(await policy({maxPerWallet:'20'}),{max:20,detected:true});
  assert.deepEqual(await policy({maxPerWallet:500}),{max:100,detected:true});
});
