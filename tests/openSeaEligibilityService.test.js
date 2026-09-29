const assert=require('node:assert/strict');
const test=require('node:test');
const {Wallet}=require('ethers');
const {createOpenSeaEligibilityService,ELIGIBILITY_SCOPE,siwePayload}=require('../src/mint/openSeaEligibilityService');

const PRIVATE_KEY=`0x${'11'.repeat(32)}`;
const SIGNER=new Wallet(PRIVATE_KEY);
const WALLET={id:7,label:'main',address:SIGNER.address,keyEnvelope:{ciphertext:'wallet-key'}};
const ENVELOPE={ciphertext:'encrypted-pat',salt:'salt',nonce:'nonce',authTag:'tag',keyVersion:1};

function savedRecord(overrides={}){
  return {userId:'user-a',walletId:WALLET.id,walletAddress:WALLET.address,scopedTokenId:'pat-id',
    tokenEnvelope:ENVELOPE,scopes:[ELIGIBILITY_SCOPE],expiresAt:Date.parse('2026-10-20T00:00:00Z'),
    createdAt:Date.parse('2026-09-20T00:00:00Z'),updatedAt:Date.parse('2026-09-20T00:00:00Z'),
    lastUsedAt:null,lastError:null,...overrides};
}

test('OpenSea SIWE message includes the Ethereum account type required by wallet auth',()=>{
  const value=siwePayload(WALLET.address,'abcdefgh',new Date('2026-09-28T12:00:00Z'));
  assert.match(value.message,/wants you to sign in with your Ethereum account:/);
  assert.equal(value.parsed.accountType,'Ethereum');
  assert.equal(value.parsed.address,WALLET.address);
});

test('authorization stores only an encrypted least-scope PAT and returns no credential material',async()=>{
  let saved=null;
  const repository={get:async()=>null,save:async input=>{saved=input;return savedRecord({
    userId:input.userId,walletId:input.walletId,walletAddress:input.walletAddress,
    scopedTokenId:input.scopedTokenId,tokenEnvelope:input.tokenEnvelope,expiresAt:input.expiresAt});}};
  const calls=[];
  const http={
    post:async(url,body)=>{
      calls.push({url,body});
      if(url.endsWith('/siwe/nonce'))return {data:{nonce:'abcdefgh'}};
      if(url.endsWith('/siwe/verify'))return {data:{},headers:{'set-cookie':['access_token=session-a; HttpOnly','refresh_token=session-r; HttpOnly']}};
      if(url.endsWith('/auth/tokens'))return {data:{id:'pat-id',token:'scoped-token',scopes:[ELIGIBILITY_SCOPE]}};
      if(url.endsWith('/tokens/exchange'))return {data:{accessToken:'wallet-jwt',expiresIn:3600,tokenScopes:[ELIGIBILITY_SCOPE]}};
      throw new Error(`unexpected POST ${url}`);
    },
    delete:async()=>({status:204}),
  };
  const service=createOpenSeaEligibilityService({repository,http,apiKey:'app-key',now:()=>Date.parse('2026-09-28T12:00:00Z'),
    encryptToken:value=>{assert.equal(value,'scoped-token');return ENVELOPE;},decryptToken:()=> 'scoped-token',
    decryptPrivateKey:()=>PRIVATE_KEY,fetchEligibility:async()=>({stages:[]})});
  const result=await service.authorize('user-a',WALLET);
  assert.deepEqual(saved.tokenEnvelope,ENVELOPE);
  assert.equal(saved.scopedTokenId,'pat-id');
  assert.deepEqual(result.scopes,[ELIGIBILITY_SCOPE]);
  const createToken=calls.find(call=>call.url.endsWith('/auth/tokens'));
  assert.deepEqual(createToken.body.scopes,[ELIGIBILITY_SCOPE]);
  assert.equal(createToken.body.expiresInDays,30);
  const serialized=JSON.stringify(result);
  for(const secret of ['scoped-token','wallet-jwt',PRIVATE_KEY,'session-a','session-r'])assert.equal(serialized.includes(secret),false);
  const verify=calls.find(call=>call.url.endsWith('/siwe/verify'));
  assert.equal(verify.body.message.accountType,'Ethereum');
});

test('a wallet with no Settings opt-in never signs automatically',async()=>{
  let signed=false;
  const repository={get:async()=>null};
  const service=createOpenSeaEligibilityService({repository,apiKey:'app-key',
    http:{post:async()=>{signed=true;throw new Error('must not sign');}},
    encryptToken:value=>value,decryptToken:value=>value,decryptPrivateKey:()=>PRIVATE_KEY,
    fetchEligibility:async()=>({stages:[]})});
  const result=await service.eligibility('user-a',WALLET,'ethereum','0x0000000000000000000000000000000000000001');
  assert.equal(result.authorization.enabled,false);
  assert.equal(result.authorization.status,'not_connected');
  assert.equal(result.stages,null);
  assert.equal(signed,false);
});

test('an expired Settings opt-in renews automatically and keeps eligibility on',async()=>{
  let current=savedRecord({expiresAt:Date.parse('2026-09-01T00:00:00Z')});let signed=0;let fetchedToken='';
  const repository={get:async()=>current,markUsed:async()=>{},markError:async()=>{},save:async input=>{
    current=savedRecord({...input,tokenEnvelope:input.tokenEnvelope,scopedTokenId:input.scopedTokenId,
      expiresAt:input.expiresAt});return current;}};
  const http={post:async(url,body)=>{
    if(url.endsWith('/siwe/nonce')){signed+=1;return {data:{nonce:'abcdefgh'}};}
    if(url.endsWith('/siwe/verify'))return {headers:{'set-cookie':['access_token=a; HttpOnly','refresh_token=r; HttpOnly']}};
    if(url.endsWith('/auth/tokens'))return {data:{id:'renewed-pat',token:'renewed-token',scopes:[ELIGIBILITY_SCOPE]}};
    if(url.endsWith('/tokens/exchange'))return {data:{accessToken:`jwt-${body.subjectToken}`,tokenScopes:[ELIGIBILITY_SCOPE],expiresIn:3600}};
    throw new Error(`unexpected POST ${url}`);
  },delete:async()=>({status:204})};
  const service=createOpenSeaEligibilityService({repository,http,apiKey:'app-key',now:()=>Date.parse('2026-09-28T12:00:00Z'),
    encryptToken:value=>({...ENVELOPE,ciphertext:value}),decryptToken:envelope=>envelope.ciphertext,
    decryptPrivateKey:()=>PRIVATE_KEY,fetchEligibility:async(_chain,_contract,token)=>{
      fetchedToken=token;return {stages:[{uuid:'public'}]};}});
  const before=await service.status('user-a',WALLET);
  assert.equal(before.enabled,true);assert.equal(before.status,'expired');
  const result=await service.eligibility('user-a',WALLET,'ethereum','0x0000000000000000000000000000000000000001');
  assert.equal(signed,1);assert.equal(current.scopedTokenId,'renewed-pat');
  assert.equal(fetchedToken,'jwt-renewed-token');
  assert.equal(result.authorization.enabled,true);assert.equal(result.authorization.connected,true);
  assert.deepEqual(result.stages,[{uuid:'public'}]);
});

test('automatic renewal cannot turn a wallet back on after a concurrent Settings disable',async()=>{
  const expired=savedRecord({expiresAt:Date.parse('2026-09-01T00:00:00Z')});let reads=0;let signed=false;
  const repository={get:async()=>{reads+=1;return reads===1?expired:null;},markError:async()=>{}};
  const service=createOpenSeaEligibilityService({repository,apiKey:'app-key',now:()=>Date.parse('2026-09-28T12:00:00Z'),
    http:{post:async()=>{signed=true;throw new Error('must not sign');}},encryptToken:value=>value,
    decryptToken:value=>value,decryptPrivateKey:()=>PRIVATE_KEY,fetchEligibility:async()=>({stages:[]})});
  const result=await service.eligibility('user-a',WALLET,'ethereum','0x0000000000000000000000000000000000000001');
  assert.equal(signed,false);
  assert.equal(result.authorization.enabled,false);
  assert.equal(result.authorization.status,'not_connected');
  assert.equal(result.stages,null);
});

test('a remotely revoked token is renewed once and the eligibility read is retried',async()=>{
  let current=savedRecord({tokenEnvelope:{...ENVELOPE,ciphertext:'old-token'}});let oldExchange=0;let created=0;
  const repository={get:async()=>current,markUsed:async()=>{},markError:async()=>{},save:async input=>{
    current=savedRecord({...input,tokenEnvelope:input.tokenEnvelope,scopedTokenId:input.scopedTokenId,
      expiresAt:input.expiresAt});return current;}};
  const http={post:async(url,body)=>{
    if(url.endsWith('/tokens/exchange')&&body.subjectToken==='old-token'){
      oldExchange+=1;const error=new Error('revoked');error.response={status:403};throw error;
    }
    if(url.endsWith('/siwe/nonce'))return {data:{nonce:'abcdefgh'}};
    if(url.endsWith('/siwe/verify'))return {headers:{'set-cookie':['access_token=a; HttpOnly','refresh_token=r; HttpOnly']}};
    if(url.endsWith('/auth/tokens')){created+=1;return {data:{id:'new-pat',token:'new-token',scopes:[ELIGIBILITY_SCOPE]}};}
    if(url.endsWith('/tokens/exchange'))return {data:{accessToken:'jwt-new',tokenScopes:[ELIGIBILITY_SCOPE],expiresIn:3600}};
    throw new Error(`unexpected POST ${url}`);
  },delete:async()=>({status:204})};
  const service=createOpenSeaEligibilityService({repository,http,apiKey:'app-key',
    encryptToken:value=>({...ENVELOPE,ciphertext:value}),decryptToken:envelope=>envelope.ciphertext,
    decryptPrivateKey:()=>PRIVATE_KEY,fetchEligibility:async()=>({stages:[{uuid:'wl'}]})});
  const result=await service.eligibility('user-a',WALLET,'ethereum','0x0000000000000000000000000000000000000001');
  assert.equal(oldExchange,1);assert.equal(created,1);
  assert.equal(current.scopedTokenId,'new-pat');assert.equal(result.authorization.connected,true);
  assert.deepEqual(result.stages,[{uuid:'wl'}]);
});

test('disconnect keeps the encrypted record when remote revocation is unavailable',async()=>{
  let removed=false;let marked=null;
  const repository={get:async()=>savedRecord(),remove:async()=>{removed=true;},markError:async(_userId,_walletId,code)=>{marked=code;}};
  const service=createOpenSeaEligibilityService({repository,apiKey:'app-key',http:{post:async()=>{throw new Error('offline');}},
    encryptToken:value=>value,decryptToken:()=> 'scoped-token',decryptPrivateKey:()=>PRIVATE_KEY,
    fetchEligibility:async()=>({stages:[]}),log:()=>{}});
  await assert.rejects(service.revoke('user-a',WALLET),error=>error.code==='OPENSEA_REVOKE_FAILED');
  assert.equal(removed,false,'the token id must remain available for a later safe retry');
  assert.equal(marked,'OPENSEA_REVOKE_FAILED');
});

test('an already-expired PAT can be removed locally without another wallet signature',async()=>{
  let removed=false;let signed=false;
  const repository={get:async()=>savedRecord({expiresAt:Date.parse('2026-09-01T00:00:00Z')}),
    remove:async()=>{removed=true;}};
  const service=createOpenSeaEligibilityService({repository,apiKey:'app-key',http:{post:async()=>{signed=true;throw new Error('unexpected');}},
    encryptToken:value=>value,decryptToken:()=> 'scoped-token',decryptPrivateKey:()=>PRIVATE_KEY,
    fetchEligibility:async()=>({stages:[]}),now:()=>Date.parse('2026-09-28T12:00:00Z')});
  const result=await service.revoke('user-a',WALLET);
  assert.equal(removed,true);assert.equal(signed,false);assert.equal(result.remoteRevoked,false);
});

test('reauthorization with a warm JWT cache validates the newly created PAT, not the old one',async()=>{
  const old=savedRecord({tokenEnvelope:{...ENVELOPE,ciphertext:'old-envelope'},scopedTokenId:'old-pat'});
  let current=old;const exchanges=[];const deletes=[];
  const repository={get:async()=>current,markUsed:async()=>{},save:async input=>{
    current=savedRecord({...input,tokenEnvelope:input.tokenEnvelope});return current;}};
  const http={post:async(url,body)=>{
    if(url.endsWith('/tokens/exchange')){exchanges.push(body.subjectToken);return {data:{accessToken:`jwt-${body.subjectToken}`,tokenScopes:[ELIGIBILITY_SCOPE],expiresIn:3600}};}
    if(url.endsWith('/siwe/nonce'))return {data:{nonce:'abcdefgh'}};
    if(url.endsWith('/siwe/verify'))return {headers:{'set-cookie':['access_token=a; HttpOnly','refresh_token=r; HttpOnly']}};
    if(url.endsWith('/auth/tokens'))return {data:{id:'new-pat',token:'new-token',scopes:[ELIGIBILITY_SCOPE]}};
    throw new Error(`unexpected POST ${url}`);
  },delete:async url=>{deletes.push(url);return {status:204};}};
  const service=createOpenSeaEligibilityService({repository,http,apiKey:'app-key',decryptPrivateKey:()=>PRIVATE_KEY,
    encryptToken:value=>({...ENVELOPE,ciphertext:`encrypted-${value}`}),
    decryptToken:envelope=>envelope.ciphertext==='old-envelope'?'old-token':'new-token',
    fetchEligibility:async()=>({stages:[]}),now:()=>Date.parse('2026-09-28T12:00:00Z')});
  await service.eligibility('user-a',WALLET,'ethereum','0x0000000000000000000000000000000000000001');
  await service.authorize('user-a',WALLET);
  assert.deepEqual(exchanges,['old-token','new-token']);
  assert.equal(current.scopedTokenId,'new-pat');
  assert.equal(deletes.some(url=>url.endsWith('/old-pat')),true);
});

test('missing server configuration never reports a stored authorization as usable',async()=>{
  const service=createOpenSeaEligibilityService({repository:{get:async()=>savedRecord()},
    encryptToken:value=>value,decryptToken:value=>value,decryptPrivateKey:()=>PRIVATE_KEY,
    fetchEligibility:async()=>({stages:[]}),apiKey:null});
  const result=await service.status('user-a',WALLET);
  assert.equal(result.configured,false);assert.equal(result.status,'configuration_missing');
  assert.equal(result.connected,false);assert.equal(result.credentialStored,true);
});

test('an unexpected exchanged scope attempts one renewal and remains unavailable when renewal fails',async()=>{
  const repository={get:async()=>savedRecord(),markError:async()=>{}};
  const service=createOpenSeaEligibilityService({repository,apiKey:'app-key',
    http:{post:async()=>({data:{accessToken:'jwt',tokenScopes:[ELIGIBILITY_SCOPE,'write:orders']}})},
    encryptToken:value=>value,decryptToken:()=> 'scoped-token',decryptPrivateKey:()=>PRIVATE_KEY,
    fetchEligibility:async()=>({stages:[]})});
  const result=await service.eligibility('user-a',WALLET,'ethereum','0x0000000000000000000000000000000000000001');
  assert.equal(result.authorization.status,'unavailable');
  assert.equal(result.authorization.enabled,true);
  assert.equal(result.authorization.connected,false);
});
