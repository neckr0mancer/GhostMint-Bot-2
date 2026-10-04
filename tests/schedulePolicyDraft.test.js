const assert=require('node:assert/strict');
const test=require('node:test');
const {parseEther}=require('ethers');
const {canFollowTimeChanges,clearPriceCap,setPriceCap,taskPolicyInput,toggleAutoReschedule}
  =require('../src/scheduler/schedulePolicyDraft');

test('bot schedule policy drafts default closed and only forward an explicit bounded opt-in',()=>{
  const base={priceETH:'0.01',expectedPriceWeiPerItem:parseEther('0.01').toString(),
    stageUuid:'stage-public'};
  assert.deepEqual(taskPolicyInput(base),{
    autoReschedule:false,acceptPriceChanges:false,
    expectedPriceWeiPerItem:parseEther('0.01').toString(),
  });
  const time=toggleAutoReschedule(base);
  assert.equal(time.autoReschedule,true);
  const capped=setPriceCap(time,'0.025');
  assert.equal(capped.ok,true);
  assert.deepEqual(taskPolicyInput(capped.data),{
    autoReschedule:true,acceptPriceChanges:true,
    expectedPriceWeiPerItem:parseEther('0.01').toString(),
    maxPriceWeiPerItem:parseEther('0.025').toString(),
  });
  assert.deepEqual(taskPolicyInput(clearPriceCap(capped.data)),{
    autoReschedule:true,acceptPriceChanges:false,
    expectedPriceWeiPerItem:parseEther('0.01').toString(),
  });
});

test('time following is unavailable without one stable provider stage identity',()=>{
  const plain={priceETH:'0'};
  assert.equal(canFollowTimeChanges(plain),false);
  assert.equal(toggleAutoReschedule(plain).autoReschedule,false);
  assert.equal(taskPolicyInput({...plain,autoReschedule:true}).autoReschedule,false);
  assert.equal(canFollowTimeChanges({viaOpenSea:false,stageLabel:'seadrop_public_drop'}),false);
  assert.equal(canFollowTimeChanges({viaOpenSea:false,stageType:'seadrop_public_drop'}),true);
});

test('a bot cannot save an invalid, zero, or below-current automatic price cap',()=>{
  const base={expectedPriceWeiPerItem:parseEther('0.02').toString()};
  assert.equal(setPriceCap(base,'not-a-number').ok,false);
  assert.equal(setPriceCap(base,'0').ok,false);
  const below=setPriceCap(base,'0.019');
  assert.equal(below.ok,false);
  assert.match(below.message,/cannot be below the current price/);
  assert.equal(setPriceCap(base,'0.02').ok,true);
  assert.equal(setPriceCap(base,'1001').ok,false);
  assert.equal(setPriceCap(base,'9'.repeat(100)).ok,false);
});
