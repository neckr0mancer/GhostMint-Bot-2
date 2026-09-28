const assert=require('node:assert/strict');
const test=require('node:test');
const {createOpenSeaEligibilityRepository,mapAuthorization}=require('../src/mint/openSeaEligibilityRepository');

const ROW={wallet_id:'7',user_id:'user-a',wallet_address:'0x0000000000000000000000000000000000000001',
  scoped_token_id:'pat-id',encrypted_scoped_token:'ciphertext',encryption_salt:'salt',
  encryption_nonce:'nonce',encryption_auth_tag:'tag',encryption_key_version:'2',
  scopes:['read:eligibility'],expires_at:'2026-10-20T00:00:00.000Z',
  created_at:'2026-09-20T00:00:00.000Z',updated_at:'2026-09-21T00:00:00.000Z',
  last_used_at:null,last_error_code:null};

test('repository maps only the encrypted token envelope and durable authorization metadata',()=>{
  const value=mapAuthorization(ROW);
  assert.deepEqual(value.tokenEnvelope,{ciphertext:'ciphertext',salt:'salt',nonce:'nonce',authTag:'tag',keyVersion:2});
  assert.equal(value.walletId,7);assert.equal(value.userId,'user-a');
  assert.equal(value.expiresAt,Date.parse(ROW.expires_at));
  assert.equal(JSON.stringify(value).includes('plaintext-token'),false);
});

test('repository reads, updates, and removes authorizations with both tenant and wallet ids',async()=>{
  const calls=[];const pool={query:async(sql,args)=>{calls.push({sql,args});return {rows:[ROW]};}};
  const repository=createOpenSeaEligibilityRepository(pool);
  await repository.get('user-a',7);
  await repository.markUsed('user-a',7);
  await repository.markError('user-a',7,'OPENSEA_AUTH_REAUTHORIZE');
  await repository.remove('user-a',7);
  for(const call of calls)assert.deepEqual(call.args.slice(0,2),['user-a',7]);
  assert.match(calls[0].sql,/WHERE user_id=\$1 AND wallet_id=\$2/);
  assert.match(calls.at(-1).sql,/DELETE FROM[\s\S]*WHERE user_id=\$1 AND wallet_id=\$2/);
});

test('repository save uses the composite owner key and persists no plaintext token field',async()=>{
  let captured=null;const pool={query:async(sql,args)=>{captured={sql,args};return {rows:[ROW]};}};
  const repository=createOpenSeaEligibilityRepository(pool);
  await repository.save({userId:'user-a',walletId:7,walletAddress:ROW.wallet_address,
    scopedTokenId:'pat-id',tokenEnvelope:{ciphertext:'ciphertext',salt:'salt',nonce:'nonce',authTag:'tag',keyVersion:2},
    expiresAt:Date.parse(ROW.expires_at)});
  assert.match(captured.sql,/ON CONFLICT \(user_id,wallet_id\)/);
  assert.match(captured.sql,/ARRAY\['read:eligibility'\]/);
  assert.equal(captured.args.includes('plaintext-token'),false);
  assert.deepEqual(captured.args.slice(0,2),[7,'user-a']);
});
