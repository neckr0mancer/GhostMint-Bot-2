const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const test=require('node:test');
const express=require('express');
const {WebSocket}=require('ws');
const {createDashboardApi,mountDashboardRoutes}=require('../src/dashboard/api');
const {createDashboardAuthService,SESSION_COOKIE,CSRF_COOKIE}=require('../src/dashboard/authService');
const {createDashboardWebSocketHub}=require('../src/dashboard/webSocketHub');
const {LinkCodeError}=require('../src/identity/identityService');
const {createCommandRateLimiter}=require('../src/security/botSecurity');
const {createBotCommandService}=require('../src/commands/botCommandService');
const {createSchedulerWorker}=require('../src/scheduler/schedulerWorker');
const {ValidationError}=require('../src/validation/domain');
const {hashSecurityPassword}=require('../src/security/securityPassword');
const {UsernameTakenError}=require('../src/identity/postgresIdentityRepository');

function fixture(){const sessions=new Map();let counter=0;const consumed=[];const identity={consumeDashboardLinkCode:async code=>{consumed.push(code);if(code!=='VALID')throw new LinkCodeError('specific internal reason');return 'user-a';}};
  const repository={create:async value=>{const id=`session-${++counter}`;sessions.set(id,{...value,sessionId:id});return id;},resolve:async tokenHash=>[...sessions.values()].find(value=>value.tokenHash===tokenHash&&!value.revoked)||null,
    revoke:async id=>{const value=sessions.get(id);if(!value||value.revoked)return false;value.revoked=true;return true;},revokeAll:async userId=>{let count=0;for(const value of sessions.values())if(value.userId===userId&&!value.revoked){value.revoked=true;count++;}return count;}};
  const auth=createDashboardAuthService({identity,repository});return {auth,consumed,sessions};}
function cookieValues(headers){const list=typeof headers.getSetCookie==='function'?headers.getSetCookie():headers.get('set-cookie').split(/,(?=\s*[^;,]+=)/);return Object.fromEntries(list.map(value=>{const [pair]=value.split(';');const index=pair.indexOf('=');return [pair.slice(0,index),decodeURIComponent(pair.slice(index+1))];}));}
async function appServer(t){const data=fixture();const api=createDashboardApi({auth:data.auth,identityRepository:{listLinkedAccounts:async()=>[{platform:'telegram',platformUserId:'42'}],getTheme:async()=>'ghost-mint',getDisplayName:async()=>null},loginRateLimiter:createCommandRateLimiter()});const app=express();app.use(express.json());app.use(api.securityHeaders);app.post('/api/auth/login',api.login);app.post('/api/auth/logout',api.requireSession,api.requireCsrf,api.logout);app.get('/api/profile',api.requireSession,api.profile);const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));return {...data,base:`http://127.0.0.1:${server.address().port}`,server};}

test('invalid and expired-looking link codes return the same generic login error',async t=>{const {base}=await appServer(t);for(const code of ['INVALID','EXPIRED']){const response=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'Invalid or expired login code'});}});
test('valid link code creates a working session and logout revokes it server-side',async t=>{const {base}=await appServer(t);const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'VALID'})});assert.equal(login.status,204);const setCookies=typeof login.headers.getSetCookie==='function'?login.headers.getSetCookie():[login.headers.get('set-cookie')];assert.ok(setCookies.some(value=>value.startsWith(`${SESSION_COOKIE}=`)&&/HttpOnly/i.test(value)&&/Secure/i.test(value)&&/SameSite=Strict/i.test(value)));assert.ok(setCookies.some(value=>value.startsWith(`${CSRF_COOKIE}=`)&&!/HttpOnly/i.test(value)&&/Secure/i.test(value)&&/SameSite=Strict/i.test(value)));const values=cookieValues(login.headers);const cookie=`${SESSION_COOKIE}=${values[SESSION_COOKIE]}; ${CSRF_COOKIE}=${values[CSRF_COOKIE]}`;assert.equal((await fetch(`${base}/api/profile`,{headers:{cookie}})).status,200);const noCsrf=await fetch(`${base}/api/auth/logout`,{method:'POST',headers:{cookie}});assert.equal(noCsrf.status,403);const logout=await fetch(`${base}/api/auth/logout`,{method:'POST',headers:{cookie,'x-csrf-token':values[CSRF_COOKIE]}});assert.equal(logout.status,204);assert.equal((await fetch(`${base}/api/profile`,{headers:{cookie}})).status,401);});
test('unauthenticated API requests are rejected with no-store security headers',async t=>{const {base}=await appServer(t);const response=await fetch(`${base}/api/profile`);assert.equal(response.status,401);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('x-frame-options'),'DENY');assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);});

test('dashboard sessions slide forward on activity and expire after real inactivity',async()=>{
  let clock=1_000_000;const now=()=>clock;const sessions=new Map();
  const repository={
    create:async value=>{const id='session-1';sessions.set(id,{...value,sessionId:id});return id;},
    resolve:async(tokenHash,at,extendByMs)=>{const value=[...sessions.values()].find(item=>item.tokenHash===tokenHash&&!item.revoked);
      if(!value||value.expiresAt<=at)return null;value.expiresAt=at+extendByMs;
      return {sessionId:value.sessionId,userId:value.userId,csrfTokenHash:value.csrfTokenHash,expiresAt:value.expiresAt};},
    revoke:async()=>false,revokeAll:async()=>0,
  };
  const identity={consumeDashboardLinkCode:async()=>'user-a'};
  const auth=createDashboardAuthService({identity,repository,now,sessionTtlMs:1000});
  const session=await auth.login('VALID');
  const cookieHeader=`${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrfToken}`;
  clock+=500;assert.ok(await auth.authenticate(cookieHeader));
  clock+=500;assert.ok(await auth.authenticate(cookieHeader),'activity within the TTL should slide expiry forward');
  clock+=1500;assert.equal(await auth.authenticate(cookieHeader),null,'no activity for longer than the TTL must expire the session');
});

test('a session cannot be kept alive past its absolute maximum lifetime, even with continuous activity',async()=>{
  let clock=1_000_000;const now=()=>clock;const sessions=new Map();
  const repository={
    create:async value=>{const id='session-1';sessions.set(id,{...value,sessionId:id,createdAt:clock});return id;},
    resolve:async(tokenHash,at,extendByMs,maxLifetimeMs)=>{const value=[...sessions.values()].find(item=>item.tokenHash===tokenHash&&!item.revoked);
      if(!value||value.expiresAt<=at)return null;
      if(maxLifetimeMs!=null&&value.createdAt<=at-maxLifetimeMs)return null;
      value.expiresAt=at+extendByMs;
      return {sessionId:value.sessionId,userId:value.userId,csrfTokenHash:value.csrfTokenHash,expiresAt:value.expiresAt};},
    revoke:async()=>false,revokeAll:async()=>0,
  };
  const identity={consumeDashboardLinkCode:async()=>'user-a'};
  const auth=createDashboardAuthService({identity,repository,now,sessionTtlMs:1000,sessionMaxLifetimeMs:5000});
  const session=await auth.login('VALID');
  const cookieHeader=`${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrfToken}`;
  for (let i=0;i<8;i+=1) {
    clock+=600;
    const result=await auth.authenticate(cookieHeader);
    if (clock-1_000_000<5000) assert.ok(result,`activity at +${clock-1_000_000}ms should still be within the absolute cap`);
  }
  clock+=600;
  assert.equal(await auth.authenticate(cookieHeader),null,'continuous activity must not extend a session past its absolute maximum lifetime');
});

test('requireSession refreshes the session cookie Max-Age on every authenticated request',async t=>{
  const data=fixture();
  const api=createDashboardApi({auth:data.auth,identityRepository:{listLinkedAccounts:async()=>[],getTheme:async()=>'ghost-mint',setTheme:async(userId,theme)=>theme,getDisplayName:async()=>null},loginRateLimiter:createCommandRateLimiter()});
  const app=express();app.use(express.json());app.use(api.securityHeaders);
  app.post('/api/auth/login',api.login);app.get('/api/profile',api.requireSession,api.profile);
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'VALID'})});
  const values=cookieValues(login.headers);
  const cookie=`${SESSION_COOKIE}=${values[SESSION_COOKIE]}; ${CSRF_COOKIE}=${values[CSRF_COOKIE]}`;
  const profile=await fetch(`${base}/api/profile`,{headers:{cookie}});assert.equal(profile.status,200);
  const refreshed=typeof profile.headers.getSetCookie==='function'?profile.headers.getSetCookie():[profile.headers.get('set-cookie')];
  assert.ok(refreshed.some(value=>value.startsWith(`${SESSION_COOKIE}=`)&&/Max-Age=/.test(value)));
});

test('the link-code endpoint requires an authenticated session and returns the code for the resolved user',async t=>{
  const data=fixture();let capturedUserId=null;
  const commands={linkCode:async userId=>{capturedUserId=userId;return {code:'ABCDE12345',expiresAt:Date.now()+300_000};}};
  const api=createDashboardApi({auth:data.auth,identityRepository:{listLinkedAccounts:async()=>[],getTheme:async()=>'ghost-mint',setTheme:async(userId,theme)=>theme,getDisplayName:async()=>null},commands,loginRateLimiter:createCommandRateLimiter()});
  const app=express();app.use(express.json());app.use(api.securityHeaders);
  app.post('/api/auth/login',api.login);app.post('/api/auth/link-code',api.requireSession,api.requireCsrf,api.linkCode);
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const unauth=await fetch(`${base}/api/auth/link-code`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(unauth.status,401);
  const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'VALID'})});
  const values=cookieValues(login.headers);
  const cookie=`${SESSION_COOKIE}=${values[SESSION_COOKIE]}; ${CSRF_COOKIE}=${values[CSRF_COOKIE]}`;
  const response=await fetch(`${base}/api/auth/link-code`,{method:'POST',headers:{cookie,'x-csrf-token':values[CSRF_COOKIE],'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.code,'ABCDE12345');
  assert.equal(capturedUserId,'user-a');
});

function openSocket(url,cookie){return new Promise((resolve,reject)=>{const socket=new WebSocket(url,{headers:cookie?{Cookie:cookie}:{}});const messages=[];socket.on('message',value=>messages.push(JSON.parse(value.toString())));socket.once('open',()=>resolve({socket,messages}));socket.once('unexpected-response',(request,response)=>reject(Object.assign(new Error('rejected'),{statusCode:response.statusCode})));socket.once('error',reject);});}
function nextMessage(socket){return new Promise(resolve=>socket.once('message',value=>resolve(JSON.parse(value.toString()))));}
test('WebSocket rejects unauthenticated clients and isolates user broadcasts',async t=>{const sessions=new Map([['token-a',{userId:'user-a'}],['token-b',{userId:'user-b'}]]);const auth={authenticate:async header=>sessions.get(String(header||'').split('=')[1])||null};const hub=createDashboardWebSocketHub({auth});const server=http.createServer();hub.attach(server);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await hub.close();await new Promise(resolve=>server.close(resolve));});const url=`ws://127.0.0.1:${server.address().port}/ws`;
  await assert.rejects(openSocket(url),error=>error.statusCode===401);const a=await openSocket(url,`${SESSION_COOKIE}=token-a`);const b=await openSocket(url,`${SESSION_COOKIE}=token-b`);await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(a.messages.shift(),{type:'connected'});assert.deepEqual(b.messages.shift(),{type:'connected'});const message=nextMessage(a.socket);hub.broadcastToUser('user-a',{type:'test',value:'only-a'});assert.deepEqual(await message,{type:'test',value:'only-a'});await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(b.messages,[]);a.socket.close();b.socket.close();});

test('dashboard production bundle contains no server secrets or secret variable names',()=>{const root=path.join(__dirname,'..','public','dashboard');assert.equal(fs.existsSync(path.join(root,'index.html')),true,'dashboard must be built before tests');const content=fs.readdirSync(path.join(root,'assets')).map(name=>fs.readFileSync(path.join(root,'assets',name),'utf8')).join('\n');const forbidden=['ENCRYPTION_SECRET','DATABASE_URL','DISCORD_BOT_TOKEN','TELEGRAM_BOT_TOKEN','dev-encryption-key-7Qv9'];const envPath=path.join(__dirname,'..','.env');if(fs.existsSync(envPath)){const values=require('dotenv').parse(fs.readFileSync(envPath));for(const name of ['ENCRYPTION_SECRET','DISCORD_BOT_TOKEN','TELEGRAM_BOT_TOKEN','SOCIAL_OFFICIAL_API_TOKEN','SOCIAL_MANAGED_SERVICE_TOKEN'])if(values[name]?.length>=8)forbidden.push(values[name]);}for(const value of forbidden)assert.equal(content.includes(value),false,`bundle contains forbidden server value: ${value.startsWith('dev-')?value:'[redacted]'}`);});

async function operationsServer(t){const sessions=new Map([['token-a',{userId:'user-a',csrfTokenHash:'csrf'}],['token-b',{userId:'user-b',csrfTokenHash:'csrf'}]]);const privateKey=`0x${'11'.repeat(32)}`;const calls=[];const selectedPresets=new Map();const commands={
  wallets:userId=>userId==='user-a'?[{label:'alpha',address:'0x0000000000000000000000000000000000000001',chain:'ethereum',keyEnvelope:{ciphertext:'secret'}}]:[],
  walletBalance:async(userId,label)=>({label,address:'0x0000000000000000000000000000000000000001',chain:'ethereum',balances:[{chain:'ethereum',balance:'1.0',symbol:'ETH'}]}),
  createWallet:async()=>({label:'new',address:'0x0000000000000000000000000000000000000002',chain:'ethereum',privateKey}),
  importWallet:async()=>{throw Object.assign(new Error(`bad key ${privateKey}`),{privateKey});},removeWallet:async(userId,label)=>{if(userId!=='user-a')throw new ValidationError({field:'label',message:'was not found'});calls.push(['remove',userId,label]);},
  exportWalletKeystore:async(userId,label,password)=>{if(userId!=='user-a'||label!=='alpha')throw new ValidationError({field:'label',message:'was not found'});if(String(password||'').length<12)throw new ValidationError({field:'securityPassword',message:'must contain 12-200 characters'});calls.push(['export',userId,label]);return {label,keystore:'{"encrypted":"keystore-json"}'};},
  mintPresets:async()=>[],prepareMint:async(userId,input)=>({wallet:{label:input.walletLabel,address:'0x0000000000000000000000000000000000000001',chain:'ethereum'},prepared:{preview:{contractAddress:'0x0000000000000000000000000000000000000003',methodSignature:'mint(uint256)',nativeValue:'0 ETH',arguments:[{name:'quantity',value:'1'}]}},simulation:{simulationEnabled:false,simulationPerformed:true,simulationPassed:true,gasLimit:21000n,estimatedCostWei:1n}}),
  submitPreparedMint:async(userId,value)=>{if(value.wallet.label==='broken')throw new ValidationError({field:'walletLabel',message:'insufficient funds'});calls.push(['mint',userId,value.simulation.simulationPassed]);return {state:'pending'};},
  tasksPage:async userId=>({page:1,pageSize:10,total:userId==='user-a'?1:0,totalPages:1,items:userId==='user-a'?[{id:'task-a'}]:[]}),createTask:async(userId,input)=>{calls.push(['task',userId,input]);return {id:'task'};},controlTask:async(userId,action,id)=>{if(userId!=='user-a'||id!=='task-a')throw new ValidationError({field:'id',message:'was not found'});calls.push(['control',userId,action,id]);return {id};},
  activityPage:async(userId,input)=>({page:Number(input.page)||1,pageSize:2,total:5,totalPages:3,items:[{id:(Number(input.page)||1)*2-1},{id:(Number(input.page)||1)*2}].filter(x=>x.id<=5).map(x=>({...x,userId}))}),
  pnl:userId=>userId==='user-a'?[{id:'pnl-a'}]:[],addPnl:async()=>({}),updatePnl:async()=>({}),deletePnl:async(userId,id)=>{if(userId!=='user-a'||id!=='pnl-a')throw new ValidationError({field:'id',message:'was not found'});calls.push(['deletePnl',userId,id]);},
  snipers:userId=>userId==='user-a'?[{id:'sniper-a'}]:[],sniperEvents:async()=>[],createSniper:async()=>({}),updateSniper:async(userId,id)=>{if(userId!=='user-a'||id!=='sniper-a')throw new ValidationError({field:'id',message:'was not found'});return {id};},removeSniper:async()=>{},
  watchRules:async userId=>userId==='user-a'?[{id:'rule-a'}]:[],watchEvents:async()=>[],createWatchRule:async()=>({}),updateWatchRule:async(userId,id)=>{if(userId!=='user-a'||id!=='rule-a')throw new ValidationError({field:'id',message:'was not found'});return {id};},disableWatchRule:async()=>{},removeWatchRule:async()=>{},
  targetDetails:async(userId,type,id)=>{if(userId!=='user-a'||!['sniper-a','rule-a'].includes(id))throw new ValidationError({field:'targetId',message:'was not found'});return {targetType:type,targetId:id};},updateTargetPolicy:async()=>({}),requestTargetBypass:async()=>({}),confirmTargetBypass:async()=>({}),applyTargetPreset:async()=>({}),modePresets:async()=>[{key:'ultra_fast',displayName:'Ultra fast',simulationMode:'optional',confirmationCount:0,humanVerification:false},{key:'safe',displayName:'Safe',simulationMode:'forced',confirmationCount:2,humanVerification:true}],
  currentMode:async userId=>selectedPresets.get(userId)?{key:selectedPresets.get(userId),displayName:selectedPresets.get(userId),simulationMode:'forced',confirmationCount:1,humanVerification:false}:null,
  selectMode:async(userId,preset)=>{if(!['ultra_fast','fast','semi_safe','safe'].includes(preset))throw new Error('Unknown mode preset');selectedPresets.set(userId,preset);return preset;},
  pendingConfirmations:async()=>[],confirmTrigger:async()=>({}),
 };
 const auth={authenticate:async header=>sessions.get(String(header||'').split('=')[1])||null,verifyCsrf:({headerToken})=>headerToken==='csrf',
   loginWithUserId:async userId=>{const token=`token-login-${userId}-${sessions.size}`;sessions.set(token,{userId});return {token};},
   sessionCookies:session=>[`ghostmint_session=${session.token}`],clearCookies:()=>[],revoke:async()=>{},revokeAll:async()=>{}};
 const themes=new Map();
 const securityPasswordHashes=new Map([['user-a',hashSecurityPassword('a-strong-enough-password')],['user-b',hashSecurityPassword('a-strong-enough-password')]]);
 const usernames=new Map();
 const api=createDashboardApi({auth,commands,supportedChains:['ethereum'],identityRepository:{listLinkedAccounts:async()=>[],getTheme:async userId=>themes.get(userId)||'ghost-mint',setTheme:async(userId,theme)=>{themes.set(userId,theme);return theme;},getDisplayName:async()=>null,getSecurityPasswordHash:async userId=>securityPasswordHashes.get(userId)||null,setSecurityPasswordHash:async(userId,hash)=>{securityPasswordHashes.set(userId,hash);},
   getUsername:async userId=>usernames.get(userId)||null,
   setUsername:async(userId,value)=>{if([...usernames.values()].includes(value))throw new UsernameTakenError();usernames.set(userId,value);},
   findUserIdByUsername:async value=>[...usernames.entries()].find(([,name])=>name===value)?.[0]||null,
 },loginRateLimiter:createCommandRateLimiter(),passwordLoginRateLimiter:createCommandRateLimiter({limit:2,windowMs:60_000}),exportKeyRateLimiter:createCommandRateLimiter({limit:2,windowMs:60_000})});const app=express();app.use(express.json());app.use(api.securityHeaders);mountDashboardRoutes(app,api);app.use(api.error);const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));return {base:`http://127.0.0.1:${server.address().port}`,calls,privateKey,securityPasswordHashes,usernames};}
function authHeaders(user='a',write=false){return {cookie:`ghostmint_session=token-${user}`,...(write?{'content-type':'application/json','x-csrf-token':'csrf'}:{})};}
test('dashboard wallet responses and errors never expose private keys',async t=>{const {base,privateKey}=await operationsServer(t);const created=await fetch(`${base}/api/wallets/create`,{method:'POST',headers:authHeaders('a',true),body:'{}'});assert.equal(created.status,201);assert.equal((await created.text()).includes(privateKey),false);const failed=await fetch(`${base}/api/wallets/import`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({privateKey})});assert.equal(failed.status,500);assert.equal((await failed.text()).includes(privateKey),false);});
test('keystore export requires confirmation, is user-scoped, enforces a minimum password, and never returns raw key material',async t=>{const {base,calls,privateKey}=await operationsServer(t);const noConfirm=await fetch(`${base}/api/wallets/alpha/export`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({securityPassword:'a-strong-enough-password'})});assert.equal(noConfirm.status,400);const shortPassword=await fetch(`${base}/api/wallets/alpha/export`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({securityPassword:'short',confirmation:'CONFIRM'})});assert.equal(shortPassword.status,400);const crossUser=await fetch(`${base}/api/wallets/alpha/export`,{method:'POST',headers:authHeaders('b',true),body:JSON.stringify({securityPassword:'a-strong-enough-password',confirmation:'CONFIRM'})});assert.equal(crossUser.status,400);const ok=await fetch(`${base}/api/wallets/alpha/export`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({securityPassword:'a-strong-enough-password',confirmation:'CONFIRM'})});assert.equal(ok.status,200);const body=await ok.json();assert.deepEqual(Object.keys(body),['keystore']);assert.equal(body.keystore,'{"encrypted":"keystore-json"}');assert.equal(JSON.stringify(body).includes(privateKey),false);assert.deepEqual(calls.filter(call=>call[0]==='export'),[['export','user-a','alpha']]);});
test('keystore export refuses when no security password is set, and rejects an incorrect one',async t=>{const {base,securityPasswordHashes}=await operationsServer(t);securityPasswordHashes.delete('user-a');const notSet=await fetch(`${base}/api/wallets/alpha/export`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({securityPassword:'a-strong-enough-password',confirmation:'CONFIRM'})});assert.equal(notSet.status,400);assert.equal((await notSet.json()).code,'SECURITY_PASSWORD_NOT_SET');securityPasswordHashes.set('user-a',hashSecurityPassword('a-strong-enough-password'));const wrong=await fetch(`${base}/api/wallets/alpha/export`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({securityPassword:'a-different-password',confirmation:'CONFIRM'})});assert.equal(wrong.status,401);});
test('keystore export is rate limited independently of other sensitive commands',async t=>{const {base}=await operationsServer(t);const attempt=()=>fetch(`${base}/api/wallets/alpha/export`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({securityPassword:'a-strong-enough-password',confirmation:'CONFIRM'})});assert.equal((await attempt()).status,200);assert.equal((await attempt()).status,200);const limited=await attempt();assert.equal(limited.status,429);assert.ok(limited.headers.get('retry-after'));});
// Split across separate operationsServer(t) instances rather than firing several requests at the
// same endpoint in one test -- each instance gets its own exportKeyRateLimiter (limit 2/60s in this
// fixture), and 'securitypassword' shares that limiter's bucket with 'exportkey' by design (see
// dashboard/api.js), so more than two calls in one instance hits 429 instead of exercising the
// scenario being tested.
test('security password can be set for the first time without a current password',async t=>{const {base,securityPasswordHashes}=await operationsServer(t);securityPasswordHashes.delete('user-a');const firstSet=await fetch(`${base}/api/auth/security-password`,{method:'PUT',headers:authHeaders('a',true),body:JSON.stringify({newPassword:'a-brand-new-password'})});assert.equal(firstSet.status,200);});
test('security password change is rejected without the current password',async t=>{const {base}=await operationsServer(t);const missingCurrent=await fetch(`${base}/api/auth/security-password`,{method:'PUT',headers:authHeaders('a',true),body:JSON.stringify({newPassword:'another-new-password'})});assert.equal(missingCurrent.status,401);});
test('security password change is rejected with an incorrect current password',async t=>{const {base}=await operationsServer(t);const wrongCurrent=await fetch(`${base}/api/auth/security-password`,{method:'PUT',headers:authHeaders('a',true),body:JSON.stringify({currentPassword:'not-it-at-all',newPassword:'another-new-password'})});assert.equal(wrongCurrent.status,401);});
test('security password changes with the correct current password, and the new one immediately works for export',async t=>{const {base}=await operationsServer(t);const changed=await fetch(`${base}/api/auth/security-password`,{method:'PUT',headers:authHeaders('a',true),body:JSON.stringify({currentPassword:'a-strong-enough-password',newPassword:'another-new-password'})});assert.equal(changed.status,200);const exported=await fetch(`${base}/api/wallets/alpha/export`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({securityPassword:'another-new-password',confirmation:'CONFIRM'})});assert.equal(exported.status,200);});
test('mint confirmation requires a simulation-backed, user-bound, single-use preview',async t=>{const {base,calls}=await operationsServer(t);const direct=await fetch(`${base}/api/mints/confirm`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({confirmation:'CONFIRM'})});assert.equal(direct.status,400);const preview=await (await fetch(`${base}/api/mints/preview`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({walletLabel:'alpha'})})).json();assert.equal(preview.items[0].simulation.simulationPassed,true);assert.equal(preview.items[0].simulation.simulationPerformed,true);assert.equal((await fetch(`${base}/api/mints/confirm`,{method:'POST',headers:authHeaders('b',true),body:JSON.stringify({previewToken:preview.previewToken,confirmation:'CONFIRM'})})).status,400);const second=await (await fetch(`${base}/api/mints/preview`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({walletLabel:'alpha'})})).json();assert.equal((await fetch(`${base}/api/mints/confirm`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({previewToken:second.previewToken,confirmation:'CONFIRM'})})).status,202);assert.deepEqual(calls.at(-1),['mint','user-a',true]);assert.equal((await fetch(`${base}/api/mints/confirm`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({previewToken:second.previewToken,confirmation:'CONFIRM'})})).status,400);});
// No test previously exercised the walletLabels array path at all -- previewMint/confirmMint's
// loops (src/dashboard/api.js) were only ever run with a single walletLabel.
test('batch mint preview/confirm resolves each wallet label independently and submits one transaction per wallet',async t=>{const {base,calls}=await operationsServer(t);const preview=await (await fetch(`${base}/api/mints/preview`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({walletLabels:['alpha','alpha-2']})})).json();assert.equal(preview.items.length,2);assert.deepEqual(preview.items.map(item=>item.wallet.label),['alpha','alpha-2']);const confirm=await fetch(`${base}/api/mints/confirm`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({previewToken:preview.previewToken,confirmation:'CONFIRM'})});assert.equal(confirm.status,202);const body=await confirm.json();assert.deepEqual(body.results.map(entry=>[entry.label,entry.status]),[['alpha','success'],['alpha-2','success']]);assert.deepEqual(calls.filter(call=>call[0]==='mint').map(call=>call[1]),['user-a','user-a']);});
// confirmMint's for-of loop (src/dashboard/api.js) catches each entry independently -- one wallet's
// failure (insufficient balance, a stale wallet, etc.) no longer cancels the rest of the batch or
// hides that they already succeeded. Every entry gets its own status and, on failure, a reason.
test('a failure on one wallet in a batch confirmation does not cancel the others, and reports its own reason',async t=>{const {base,calls}=await operationsServer(t);const preview=await (await fetch(`${base}/api/mints/preview`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({walletLabels:['alpha','broken']})})).json();assert.equal(preview.items.length,2);const confirm=await fetch(`${base}/api/mints/confirm`,{method:'POST',headers:authHeaders('a',true),body:JSON.stringify({previewToken:preview.previewToken,confirmation:'CONFIRM'})});assert.equal(confirm.status,202);const body=await confirm.json();assert.deepEqual(body.results.map(entry=>entry.label),['alpha','broken']);const [alphaResult,brokenResult]=body.results;assert.equal(alphaResult.status,'success');assert.equal(brokenResult.status,'failed');assert.equal(brokenResult.error,'walletLabel insufficient funds');assert.deepEqual(calls.filter(call=>call[0]==='mint').map(call=>call[1]),['user-a']);});
test('dashboard resources are user scoped and activity pagination has exact boundaries',async t=>{const {base,calls}=await operationsServer(t);assert.equal((await (await fetch(`${base}/api/wallets`,{headers:authHeaders('b')})).json()).length,0);assert.equal((await (await fetch(`${base}/api/tasks`,{headers:authHeaders('b')})).json()).total,0);assert.equal((await (await fetch(`${base}/api/pnl`,{headers:authHeaders('b')})).json()).length,0);const pages=[];for(const page of [1,2,3])pages.push(await (await fetch(`${base}/api/activity?page=${page}`,{headers:authHeaders('a')})).json());assert.deepEqual(pages.flatMap(value=>value.items.map(item=>item.id)),[1,2,3,4,5]);const deniedWallet=await fetch(`${base}/api/wallets/alpha`,{method:'DELETE',headers:authHeaders('b',true),body:JSON.stringify({confirmation:'CONFIRM'})});const deniedTask=await fetch(`${base}/api/tasks/task-a/control`,{method:'POST',headers:authHeaders('b',true),body:JSON.stringify({action:'cancel',confirmation:'CONFIRM'})});const deniedPnl=await fetch(`${base}/api/pnl/pnl-a`,{method:'DELETE',headers:authHeaders('b',true),body:JSON.stringify({confirmation:'CONFIRM'})});assert.deepEqual([deniedWallet.status,deniedTask.status,deniedPnl.status],[400,400,400]);assert.equal(calls.some(call=>['remove','control','deletePnl'].includes(call[0])),false);});

test('dashboard trigger endpoints cannot expose or configure another user targets',async t=>{const {base}=await operationsServer(t);const [snipers,rules]=await Promise.all([fetch(`${base}/api/snipers`,{headers:authHeaders('b')}),fetch(`${base}/api/watch-rules`,{headers:authHeaders('b')})]);assert.deepEqual((await snipers.json()).items,[]);assert.deepEqual((await rules.json()).items,[]);const target=await fetch(`${base}/api/targets/sniper-a?type=sniper`,{headers:authHeaders('b')});const sniper=await fetch(`${base}/api/snipers/sniper-a`,{method:'PUT',headers:authHeaders('b',true),body:'{}'});const rule=await fetch(`${base}/api/watch-rules/rule-a`,{method:'PUT',headers:authHeaders('b',true),body:'{}'});assert.deepEqual([target.status,sniper.status,rule.status],[400,400,400]);});

test('profile reports the account dashboard theme, defaulting to ghost-mint',async t=>{const {base}=await operationsServer(t);const profile=await (await fetch(`${base}/api/profile`,{headers:authHeaders('a')})).json();assert.equal(profile.theme,'ghost-mint');});
test('dashboard theme updates persist per account, reject unknown themes, and require CSRF',async t=>{const {base}=await operationsServer(t);
  const noCsrf=await fetch(`${base}/api/profile/theme`,{method:'PUT',headers:{cookie:'ghostmint_session=token-a','content-type':'application/json'},body:JSON.stringify({theme:'clean-vault'})});
  assert.equal(noCsrf.status,403);
  const invalid=await fetch(`${base}/api/profile/theme`,{method:'PUT',headers:authHeaders('a',true),body:JSON.stringify({theme:'not-a-theme'})});
  assert.equal(invalid.status,400);
  const updated=await fetch(`${base}/api/profile/theme`,{method:'PUT',headers:authHeaders('a',true),body:JSON.stringify({theme:'clean-vault'})});
  assert.equal(updated.status,200);
  assert.deepEqual(await updated.json(),{theme:'clean-vault'});
  const profileA=await (await fetch(`${base}/api/profile`,{headers:authHeaders('a')})).json();
  assert.equal(profileA.theme,'clean-vault');
  const profileB=await (await fetch(`${base}/api/profile`,{headers:authHeaders('b')})).json();
  assert.equal(profileB.theme,'ghost-mint');
});
// This exercises the HTTP layer only (routing, CSRF, status codes) against operationsServer's
// fake commands.selectMode (which accepts any of the 4 keys unconditionally) -- it does not run
// through the real postgresGovernanceRepository.selectPreset, which now gates ultra_fast/fast
// behind advanced_modes_allowed (migration 038). That gating has no automated coverage in this
// environment since it needs a real pool.query against Postgres, unavailable here.
test('the mode-preset API accepts any of the four keys the fake commands layer reports and reflects the selection back',async t=>{
  const {base}=await operationsServer(t);
  const presets=await (await fetch(`${base}/api/mode-presets`,{headers:authHeaders('a')})).json();
  assert.deepEqual(presets.map(preset=>preset.key),['ultra_fast','safe']);
  const before=await (await fetch(`${base}/api/profile`,{headers:authHeaders('a')})).json();
  assert.equal(before.currentMode,null);
  const noCsrf=await fetch(`${base}/api/profile/mode`,{method:'PUT',headers:{cookie:'ghostmint_session=token-a','content-type':'application/json'},body:JSON.stringify({preset:'ultra_fast'})});
  assert.equal(noCsrf.status,403);
  const selected=await fetch(`${base}/api/profile/mode`,{method:'PUT',headers:authHeaders('a',true),body:JSON.stringify({preset:'ultra_fast'})});
  assert.equal(selected.status,200);
  assert.deepEqual(await selected.json(),{mode:'ultra_fast'});
  const after=await (await fetch(`${base}/api/profile`,{headers:authHeaders('a')})).json();
  assert.equal(after.currentMode.key,'ultra_fast');
});

test('setting a username requires a security password first, rejects bad formats, and enforces uniqueness',async t=>{
  const {base,securityPasswordHashes}=await operationsServer(t);
  securityPasswordHashes.delete('user-a');
  const noPassword=await fetch(`${base}/api/auth/username`,{method:'PUT',headers:authHeaders('a',true),body:JSON.stringify({username:'ghostuser'})});
  assert.equal(noPassword.status,400);
  assert.equal((await noPassword.json()).code,'SECURITY_PASSWORD_NOT_SET');
  securityPasswordHashes.set('user-a',hashSecurityPassword('a-strong-enough-password'));
  const badFormat=await fetch(`${base}/api/auth/username`,{method:'PUT',headers:authHeaders('a',true),body:JSON.stringify({username:'Not Valid!'})});
  assert.equal(badFormat.status,400);
  const set=await fetch(`${base}/api/auth/username`,{method:'PUT',headers:authHeaders('a',true),body:JSON.stringify({username:'ghostuser'})});
  assert.equal(set.status,200);
  assert.deepEqual(await set.json(),{username:'ghostuser'});
  securityPasswordHashes.set('user-b',hashSecurityPassword('a-strong-enough-password'));
  const taken=await fetch(`${base}/api/auth/username`,{method:'PUT',headers:authHeaders('b',true),body:JSON.stringify({username:'ghostuser'})});
  assert.equal(taken.status,409);
});

test('username+password login fails identically for an unknown username or a wrong password, is rate limited per username, and succeeds with correct credentials',async t=>{
  const {base,securityPasswordHashes,usernames}=await operationsServer(t);
  usernames.set('user-a','ghostuser');
  securityPasswordHashes.delete('user-a');
  const unknownUser=await fetch(`${base}/api/auth/login-password`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'nobody-here',password:'whatever-password'})});
  assert.equal(unknownUser.status,401);
  const unknownBody=await unknownUser.json();
  // 'ghostuser' currently has no security password set at all -- still a generic 401, not a
  // different error, so a wrong/never-set password can't be distinguished from a wrong username.
  const noPasswordSet=await fetch(`${base}/api/auth/login-password`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'ghostuser',password:'whatever-password'})});
  assert.equal(noPasswordSet.status,401);
  assert.deepEqual(unknownBody,await noPasswordSet.json());
  // This is the 2nd attempt against the 'ghostuser' bucket (limit is 2/60s in this fixture) --
  // still allowed through to the credential check itself.
  securityPasswordHashes.set('user-a',hashSecurityPassword('a-strong-enough-password'));
  const wrongPassword=await fetch(`${base}/api/auth/login-password`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'ghostuser',password:'totally-wrong-password'})});
  assert.equal(wrongPassword.status,401);
  // 3rd attempt against 'ghostuser' -- now rate limited, even with the correct password.
  const limited=await fetch(`${base}/api/auth/login-password`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'ghostuser',password:'a-strong-enough-password'})});
  assert.equal(limited.status,429);
  assert.ok(limited.headers.get('retry-after'));
});
test('username+password login creates a working, cookie-authenticated session for the resolved user',async t=>{
  const {base,securityPasswordHashes,usernames}=await operationsServer(t);
  usernames.set('user-a','ghostuser');
  securityPasswordHashes.set('user-a',hashSecurityPassword('a-strong-enough-password'));
  const login=await fetch(`${base}/api/auth/login-password`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'ghostuser',password:'a-strong-enough-password'})});
  assert.equal(login.status,204);
  const setCookie=login.headers.get('set-cookie');
  assert.ok(setCookie&&setCookie.startsWith('ghostmint_session='));
  const profile=await (await fetch(`${base}/api/profile`,{headers:{cookie:setCookie}})).json();
  assert.equal(profile.username,'ghostuser');
});

test('an out-of-range page or pageSize is a 400 naming the field, not a 500',async t=>{
  // operationsServer stubs the commands layer, so it never reaches the real pagination(). This
  // wires the actual command service to prove the status the CALLER sees: ?pageSize=100 used to
  // surface as 500 "Request failed safely", indistinguishable from the database being down.
  const state={wallets:[],tasks:[],activity:[],pnl:[],snipers:[]};
  const commands=createBotCommandService({storage:{},schedulerRepository:{},providerService:{},governance:{},
    adminCommands:{},sniperService:{},supportedChains:['ethereum'],chains:{ethereum:{}},encryptPrivateKey:()=>({}),getState:()=>state});
  const sessions=new Map([['token-a',{userId:'user-a',csrfTokenHash:'csrf'}]]);
  const auth={authenticate:async header=>sessions.get(String(header||'').split('=')[1])||null,verifyCsrf:()=>true,
    loginWithUserId:async()=>({token:'token-a'}),sessionCookies:()=>[],clearCookies:()=>[],revoke:async()=>{},revokeAll:async()=>{}};
  const api=createDashboardApi({auth,commands,supportedChains:['ethereum'],
    identityRepository:{listLinkedAccounts:async()=>[],getTheme:async()=>'ghost-mint',getDisplayName:async()=>null},
    loginRateLimiter:createCommandRateLimiter()});
  const app=express();app.use(express.json());app.use(api.securityHeaders);mountDashboardRoutes(app,api);app.use(api.error);
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;const headers={cookie:'ghostmint_session=token-a'};
  for(const [query,field] of [['pageSize=100','pageSize'],['pageSize=0','pageSize'],['page=0','page'],['page=abc','page']]){
    for(const route of ['/api/tasks','/api/activity']){
      const response=await fetch(`${base}${route}?${query}`,{headers});
      assert.equal(response.status,400,`${route}?${query} should be 400`);
      const body=await response.json();
      assert.equal(body.code,'VALIDATION_ERROR');
      assert.deepEqual(body.issues.map(value=>value.field),[field]);
    }
  }
  // The cap itself is still a valid request, as is asking for nothing in particular.
  assert.equal((await fetch(`${base}/api/tasks?pageSize=50`,{headers})).status,200);
  assert.equal((await fetch(`${base}/api/activity`,{headers})).status,200);
});

test('task created by the dashboard service is consumed by the existing durable worker path',async()=>{const now=Date.now();const state={wallets:[{id:1,userId:'user-a',label:'alpha',address:'0x0000000000000000000000000000000000000001',chain:'ethereum'}],tasks:[],activity:[],pnl:[],snipers:[]};const rows=[];const repository={
  claimDue:async()=>{const task=rows.find(item=>item.status==='scheduled'&&item.nextAttemptAt<=now+10_000);if(!task)return null;task.status='claimed';task.attemptCount=1;return task;},
  attachIntent:async()=>{},complete:async task=>{task.status='succeeded';return true;},fail:async()=>{},listStaleClaims:async()=>[],getByIdempotencyKey:async()=>null,
 };
 const commands=createBotCommandService({storage:{saveTask:async task=>{rows.push(task);return true;}},schedulerRepository:repository,providerService:{},governance:{},adminCommands:{},sniperService:{},supportedChains:['ethereum'],chains:{ethereum:{}},encryptPrivateKey:()=>({}),getState:()=>state});
 const task=await commands.createTask('user-a',{name:'dashboard job',walletLabel:'alpha',contractAddress:'0x0000000000000000000000000000000000000002',quantity:1,priceETH:0,chain:'ethereum',mintTime:new Date(now+5_000).toISOString()});assert.equal(rows[0],task);
 const worker=createSchedulerWorker({repository,intentRepository:{get:async()=>null,getByIdempotencyKey:async()=>null},transactionEngine:{reconcileIntent:async value=>value},executeTask:async()=>({intentId:'intent',state:'confirmed'}),now:()=>now+10_000});assert.equal(await worker.tick(),true);assert.equal(task.status,'succeeded');});
