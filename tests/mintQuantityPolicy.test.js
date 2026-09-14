const assert=require('node:assert/strict');
const test=require('node:test');
const {pathToFileURL}=require('node:url');
const path=require('node:path');

async function policy(result){
  const module=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintQuantityPolicy.mjs')));
  return module.mintQuantityPolicy(result);
}

async function pricePerItem(result,quantity){
  const module=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintQuantityPolicy.mjs')));
  return module.mintDetectionPricePerItem(result,quantity);
}

async function totalValue(priceWeiPerItem,quantity){
  const module=await import(pathToFileURL(path.join(__dirname,'..','dashboard','src','mintQuantityPolicy.mjs')));
  return module.mintTotalValueWei(priceWeiPerItem,quantity);
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

test('detected prices stay per item and never multiply a multi-item total twice',async()=>{
  assert.equal(await pricePerItem({priceWeiPerItem:'500',valueWei:'1500'},3),'500');
  assert.equal(await pricePerItem({valueWei:'1500'},3),'500',
    'rolling deploy fallback should derive the same exact per-item value from the old response');
  assert.equal(await pricePerItem({valueWei:'1000'},3),null,
    'an inexact division must not silently round a payment');
});

test('paid multi-quantity requests send the exact total value expected by the encoder',async()=>{
  assert.equal(await totalValue('25000000000000000',4),'100000000000000000');
  assert.equal(await totalValue('0',100),'0');
  assert.equal(await totalValue('1.5',2),null);
  assert.equal(await totalValue('100',0),null);
  assert.equal(await totalValue('100',101),null);
});
