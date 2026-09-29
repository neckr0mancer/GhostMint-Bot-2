'use strict';

const axios=require('axios');
const {Wallet,getAddress}=require('ethers');

const ELIGIBILITY_SCOPE='read:eligibility';
const DEFAULT_PAT_TTL_DAYS=30;
const DEFAULT_JWT_TTL_SECONDS=3_600;
const JWT_REFRESH_BUFFER_MS=60_000;
const SIWE_STATEMENT='Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).';

class OpenSeaEligibilityError extends Error {
  constructor(code,message,status=503) {
    super(message);
    this.name='OpenSeaEligibilityError';
    this.code=code;
    this.status=status;
  }
}

function safeStatus(error) {
  return Number(error?.response?.status)||Number(error?.status)||null;
}

function sessionCookie(headers={}) {
  const values=headers['set-cookie']||headers.getSetCookie?.()||[];
  const cookies=new Map();
  for(const raw of Array.isArray(values)?values:[values]) {
    const pair=String(raw||'').split(';')[0];
    const at=pair.indexOf('=');
    if(at<1)continue;
    const name=pair.slice(0,at).trim();
    if(name==='access_token'||name==='refresh_token')cookies.set(name,pair.slice(at+1).trim());
  }
  if(!cookies.has('access_token')||!cookies.has('refresh_token')) {
    throw new OpenSeaEligibilityError('OPENSEA_AUTH_FAILED','OpenSea did not create a complete wallet session. Try again later.');
  }
  return [...cookies].map(([name,value])=>`${name}=${value}`).join('; ');
}

function siwePayload(address,nonce,issuedAt=new Date()) {
  const checksum=getAddress(address);
  const message=`opensea.io wants you to sign in with your Ethereum account:\n${checksum}\n\n${SIWE_STATEMENT}\n\nURI: https://opensea.io\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${issuedAt.toISOString()}`;
  return {
    message,
    parsed:{domain:'opensea.io',address:checksum,statement:SIWE_STATEMENT,uri:'https://opensea.io',
      version:'1',chainId:'1',nonce,issuedAt:issuedAt.toISOString(),accountType:'Ethereum'},
  };
}

function publicAuthorization(record,now=Date.now()) {
  if(!record)return {status:'not_connected',connected:false,enabled:false};
  const expired=record.expiresAt<=now;
  return {
    status:expired?'expired':'connected',connected:!expired,enabled:true,
    walletAddress:record.walletAddress,scopes:[ELIGIBILITY_SCOPE],expiresAt:record.expiresAt,
    lastUsedAt:record.lastUsedAt,lastError:record.lastError,
  };
}

function createOpenSeaEligibilityService({repository,encryptToken,decryptToken,decryptPrivateKey,
  fetchEligibility,apiKey,http=axios,baseUrl='https://api.opensea.io',timeoutMs=8_000,
  patTtlDays=DEFAULT_PAT_TTL_DAYS,now=()=>Date.now(),log=()=>{}}) {
  const jwtCache=new Map();
  const exchangeInFlight=new Map();
  const mutationInFlight=new Map();
  const requestConfig={timeout:timeoutMs,maxContentLength:1_000_000,validateStatus:status=>status>=200&&status<300};

  const walletKey=(userId,walletId)=>`${userId}:${walletId}`;
  const authorizationKey=record=>`${record.userId||''}:${record.walletId}:${record.scopedTokenId||''}`;
  function clearWalletCaches(userId,walletId) {
    const prefix=`${userId}:${walletId}:`;
    for(const key of jwtCache.keys())if(key.startsWith(prefix))jwtCache.delete(key);
  }
  async function mutateWallet(kind,userId,walletId,operation) {
    const key=walletKey(userId,walletId);
    const current=mutationInFlight.get(key);
    if(current) {
      if(current.kind===kind)return current.promise;
      await current.promise.catch(()=>{});
      return mutateWallet(kind,userId,walletId,operation);
    }
    let pending;
    pending=Promise.resolve().then(operation).finally(()=>{
      if(mutationInFlight.get(key)?.promise===pending)mutationInFlight.delete(key);
    });
    mutationInFlight.set(key,{kind,promise:pending});
    return pending;
  }

  function configured() { return Boolean(apiKey&&repository&&encryptToken&&decryptToken&&decryptPrivateKey&&fetchEligibility); }
  function failNotConfigured() {
    throw new OpenSeaEligibilityError('OPENSEA_ELIGIBILITY_NOT_CONFIGURED',
      'Early OpenSea eligibility is unavailable because the server is missing its OpenSea API key.');
  }
  async function getRecord(userId,wallet) {
    if(!repository||!wallet?.id)return null;
    const record=await repository.get(userId,wallet.id);
    if(record&&String(record.walletAddress).toLowerCase()!==String(wallet.address).toLowerCase()) {
      throw new OpenSeaEligibilityError('OPENSEA_AUTH_WALLET_MISMATCH',
        'This OpenSea authorization does not belong to the selected wallet.',500);
    }
    return record;
  }
  async function establishSession(wallet) {
    const privateKey=decryptPrivateKey(wallet);
    const signer=new Wallet(privateKey);
    if(signer.address.toLowerCase()!==String(wallet.address).toLowerCase()) {
      throw new OpenSeaEligibilityError('OPENSEA_AUTH_WALLET_MISMATCH',
        'The selected wallet could not be verified for OpenSea authorization.',500);
    }
    const nonceResponse=await http.post(`${baseUrl}/api/v2/auth/siwe/nonce`,null,requestConfig);
    const nonce=String(nonceResponse?.data?.nonce||'');
    if(!/^[a-zA-Z0-9]{8,}$/.test(nonce)) {
      throw new OpenSeaEligibilityError('OPENSEA_AUTH_FAILED','OpenSea returned an invalid sign-in challenge. Try again later.');
    }
    const payload=siwePayload(signer.address,nonce,new Date(now()));
    const signature=await signer.signMessage(payload.message);
    const verified=await http.post(`${baseUrl}/api/v2/auth/siwe/verify`,{
      message:payload.parsed,signature,chainArch:'EVM',
    },{...requestConfig,headers:{'Content-Type':'application/json'}});
    return sessionCookie(verified.headers);
  }
  async function revokeRemoteToken(cookie,tokenId) {
    if(!cookie||!tokenId)return false;
    try {
      await http.delete(`${baseUrl}/api/v2/auth/tokens/${encodeURIComponent(tokenId)}`,
        {...requestConfig,headers:{Cookie:cookie}});
      return true;
    } catch(error) {
      if(safeStatus(error)===404)return true;
      throw error;
    }
  }
  async function cleanupToken(cookie,tokenId) {
    if(!cookie||!tokenId)return;
    await revokeRemoteToken(cookie,tokenId).catch(()=>{});
  }
  async function exchange(record) {
    const key=authorizationKey(record);
    const cached=jwtCache.get(key);
    if(cached&&cached.expiresAt-now()>JWT_REFRESH_BUFFER_MS)return cached.accessToken;
    if(exchangeInFlight.has(key))return exchangeInFlight.get(key);
    const pending=(async()=>{
      const scopedToken=decryptToken(record.tokenEnvelope);
      const response=await http.post(`${baseUrl}/api/v2/auth/tokens/exchange`,{
        subjectToken:scopedToken,subjectTokenType:'ACCESS_TOKEN',
      },{...requestConfig,headers:{'Content-Type':'application/json'}});
      const accessToken=String(response?.data?.accessToken||'');
      const scopes=Array.isArray(response?.data?.tokenScopes)
        ? response.data.tokenScopes
        : typeof response?.data?.scope==='string'
          ? response.data.scope.split(/\s+/).filter(Boolean)
          : record.scopes;
      if(!accessToken||!scopes.includes(ELIGIBILITY_SCOPE)||scopes.some(scope=>scope!==ELIGIBILITY_SCOPE)) {
        throw new OpenSeaEligibilityError('OPENSEA_AUTH_SCOPE_MISMATCH',
          'OpenSea did not grant the required read-only eligibility permission.',403);
      }
      const expiresIn=Math.max(60,Number(response?.data?.expiresIn)||DEFAULT_JWT_TTL_SECONDS);
      jwtCache.set(key,{accessToken,expiresAt:now()+expiresIn*1_000});
      return accessToken;
    })();
    exchangeInFlight.set(key,pending);
    try{return await pending;}finally{exchangeInFlight.delete(key);}
  }
  function authorizationState(record) {
    if(!configured())return {configured:false,status:'configuration_missing',connected:false,
      enabled:Boolean(record),credentialStored:Boolean(record),walletAddress:record?.walletAddress||null};
    return {configured:true,...publicAuthorization(record,now())};
  }
  async function status(userId,wallet) {
    const record=await getRecord(userId,wallet);
    return authorizationState(record);
  }
  async function authorize(userId,wallet,{onlyIfNeeded=false,requireExisting=false}={}) {
    return mutateWallet('authorize',userId,wallet.id,async()=>{
      if(!configured())failNotConfigured();
      let cookie=null;let created=null;
      const previous=await getRecord(userId,wallet);
      // Automatic renewal must never recreate permission after the user turned the Settings
      // switch off while an eligibility request was already in flight.
      if(requireExisting&&!previous)return {configured:true,...publicAuthorization(null,now())};
      // A Settings opt-in is durable. Concurrent reads may all notice an expired PAT at once, so
      // automatic renewal re-checks the row while holding this wallet's mutation lock and reuses a
      // token another request has already refreshed.
      if(onlyIfNeeded&&previous&&previous.expiresAt>now()) {
        return {configured:true,...publicAuthorization(previous,now())};
      }
      clearWalletCaches(userId,wallet.id);
      try {
        cookie=await establishSession(wallet);
        const response=await http.post(`${baseUrl}/api/v2/auth/tokens`,{
          label:`GhostMint eligibility ${String(wallet.address).slice(0,8)}`,
          scopes:[ELIGIBILITY_SCOPE],expiresInDays:patTtlDays,
        },{...requestConfig,headers:{'Content-Type':'application/json',Cookie:cookie}});
        created=response.data;
        if(!created?.id||!created?.token||!Array.isArray(created.scopes)
          ||!created.scopes.includes(ELIGIBILITY_SCOPE)||created.scopes.some(scope=>scope!==ELIGIBILITY_SCOPE)) {
          throw new OpenSeaEligibilityError('OPENSEA_AUTH_SCOPE_MISMATCH',
            'OpenSea did not create the expected read-only eligibility permission.',403);
        }
        const probe={userId,walletId:wallet.id,scopedTokenId:created.id,
          tokenEnvelope:encryptToken(created.token),scopes:[ELIGIBILITY_SCOPE]};
        await exchange(probe);
        if(previous&&previous.scopedTokenId!==created.id&&previous.expiresAt>now()) {
          await revokeRemoteToken(cookie,previous.scopedTokenId);
        }
        const expiresAt=now()+patTtlDays*24*60*60*1_000;
        const saved=await repository.save({userId,walletId:wallet.id,walletAddress:wallet.address,
          scopedTokenId:created.id,tokenEnvelope:probe.tokenEnvelope,expiresAt});
        return {configured:true,...publicAuthorization(saved,now())};
      } catch(error) {
        clearWalletCaches(userId,wallet.id);
        if(created?.id)await cleanupToken(cookie,created.id);
        if(error instanceof OpenSeaEligibilityError)throw error;
        const status=safeStatus(error);
        log(`OpenSea wallet eligibility authorization failed: ${status?`HTTP ${status}`:error?.code||error?.name||'unknown error'}`);
        throw new OpenSeaEligibilityError('OPENSEA_AUTH_FAILED',
          status===429?'OpenSea is rate-limiting wallet authorization. Try again later.':'OpenSea could not authorize this wallet right now. Try again later.',
        status===429?429:503);
      }
    });
  }
  async function revoke(userId,wallet) {
    return mutateWallet('revoke',userId,wallet.id,async()=>{
      const record=await getRecord(userId,wallet);
      if(!record)return {configured:configured(),status:'not_connected',connected:false,enabled:false};
      if(record.expiresAt>now()) {
        try {
          const cookie=await establishSession(wallet);
          await revokeRemoteToken(cookie,record.scopedTokenId);
        } catch(error) {
          const status=safeStatus(error);
          await repository.markError(userId,wallet.id,'OPENSEA_REVOKE_FAILED').catch(()=>{});
          log(`OpenSea wallet eligibility remote revocation failed: ${status?`HTTP ${status}`:error?.code||error?.name||'unknown error'}`);
          throw new OpenSeaEligibilityError('OPENSEA_REVOKE_FAILED',
            'OpenSea could not disconnect this wallet right now. Try again later; the permission remains recorded until it is safely revoked.',503);
        }
      }
      await repository.remove(userId,wallet.id);
      clearWalletCaches(userId,wallet.id);
      return {configured:configured(),status:'not_connected',connected:false,enabled:false,remoteRevoked:record.expiresAt>now()};
    });
  }
  async function renew(userId,wallet,{force=false}={}) {
    try {
      await authorize(userId,wallet,{onlyIfNeeded:!force,requireExisting:true});
      const record=await getRecord(userId,wallet);
      return {record,authorization:authorizationState(record)};
    } catch(error) {
      const errorCode=error?.code||'OPENSEA_AUTH_RENEWAL_FAILED';
      await repository?.markError?.(userId,wallet.id,errorCode).catch(()=>{});
      const record=await getRecord(userId,wallet).catch(()=>null);
      const message=error?.status===429
        ?'OpenSea is rate-limiting the automatic eligibility check. Try again shortly.'
        :'OpenSea could not refresh the read-only eligibility check right now.';
      log(`OpenSea wallet eligibility renewal failed: ${errorCode}`);
      return {record,authorization:{...authorizationState(record),status:'unavailable',connected:false,
        enabled:Boolean(record),lastError:message},error};
    }
  }
  async function eligibility(userId,wallet,chain,contractAddress) {
    let record=await getRecord(userId,wallet);
    let authorization=authorizationState(record);
    if(!record||!configured())return {authorization,stages:null};

    // The existence of the encrypted row is the user's persistent Settings opt-in. Renew an
    // expired least-scope token server-side instead of making the user sign again every 30 days.
    if(record.expiresAt<=now()) {
      const renewed=await renew(userId,wallet);
      if(!renewed.record||renewed.authorization.status!=='connected') {
        return {authorization:renewed.authorization,stages:null};
      }
      record=renewed.record;authorization=renewed.authorization;
    }

    for(let attempt=0;attempt<2;attempt+=1) {
      try {
        const accessToken=await exchange(record);
        const result=await fetchEligibility(chain,contractAddress,accessToken);
        await repository.markUsed(userId,wallet.id);
        return {authorization:{...authorization,lastUsedAt:now(),lastError:null},stages:result?.stages||[]};
      } catch(error) {
        clearWalletCaches(userId,wallet.id);
        const status=safeStatus(error);
        const invalid=status===401||status===403;
        if(invalid&&attempt===0) {
          // OpenSea can revoke an otherwise unexpired token. A wallet whose Settings switch is on
          // gets one safe re-authorization and one retry; never loop or sign for a wallet that has
          // no persisted opt-in row.
          const renewed=await renew(userId,wallet,{force:true});
          if(!renewed.record||renewed.authorization.status!=='connected') {
            return {authorization:renewed.authorization,stages:null};
          }
          record=renewed.record;authorization=renewed.authorization;
          continue;
        }
        const errorCode=invalid?'OPENSEA_AUTH_REAUTHORIZE':'OPENSEA_ELIGIBILITY_UNAVAILABLE';
        const message=invalid?'OpenSea could not restore the read-only eligibility check. Turn it off and on again in Settings.'
          :'OpenSea eligibility could not be refreshed right now. Published stages are still available.';
        await repository.markError(userId,wallet.id,errorCode).catch(()=>{});
        log(`OpenSea wallet eligibility read failed: ${status?`HTTP ${status}`:error?.code||error?.name||'unknown error'}`);
        return {authorization:{...authorization,status:invalid?'reauthorize':'unavailable',connected:!invalid,
          enabled:true,lastError:message},stages:null};
      }
    }
    return {authorization,stages:null};
  }
  return {authorize,configured,eligibility,revoke,status};
}

module.exports={DEFAULT_PAT_TTL_DAYS,ELIGIBILITY_SCOPE,OpenSeaEligibilityError,
  createOpenSeaEligibilityService,publicAuthorization,sessionCookie,siwePayload};
