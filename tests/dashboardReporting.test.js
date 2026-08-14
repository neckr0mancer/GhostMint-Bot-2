const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const test=require('node:test');
const express=require('express');
const {createDashboardApi,mountDashboardRoutes}=require('../src/dashboard/api');
const {GasLookupError}=require('../src/gas/etherscanGasService');
const {AuthorizationError}=require('../src/governance/governanceService');
const {ValidationError}=require('../src/validation/domain');
const {createCommandRateLimiter}=require('../src/security/botSecurity');

const SUPPORTED_CHAINS=['ethereum','base'];

function fakeGas(chain){
  if(chain==='missing-key')throw new GasLookupError('MISSING_API_KEY','Gas lookup is unavailable until ETHERSCAN_API_KEY is configured');
  if(chain==='provider-down')throw new GasLookupError('PROVIDER_ERROR','Etherscan could not provide gas prices right now');
  if(!SUPPORTED_CHAINS.includes(chain))throw new ValidationError({field:'chain',message:`must be one of: ${SUPPORTED_CHAINS.join(', ')}`});
  return {chain,chainId:1,safeGasPriceGwei:10,gasPriceGwei:12,maxFeePerGasGwei:15,source:'etherscan-v2'};
}

function fakeUsageSummary(period){
  return {period,since:0,requests:42,rows:[{ruleId:'rule-1',ruleName:'announcements',method:'scraper',requestType:'read',requests:42}],
    reportedCostUsd:1.23,reportedCredits:4.5,payPerUseEstimateUsd:2.1,projectedMonthlyRequests:1260,
    pricing:{officialReadUsd:0.005,officialPostUsd:0.015,managedMonthlyTiersUsd:[199,499]},
    breakEvenRequests:[{price:199,atReadRate:39800,atPostRate:13267},{price:499,atReadRate:99800,atPostRate:33267}]};
}

async function server(t,{owner=false}={}){
  const sessions=new Map([['user',{userId:'user',sessionId:'session-user'}]]);
  const commands={
    isOwner:async()=>owner,
    gas:async chain=>fakeGas(chain),
    socialUsage:async(userId,period)=>{ if(!owner)throw new AuthorizationError(); return fakeUsageSummary(period||'month'); },
  };
  const auth={authenticate:async header=>sessions.get(String(header||'').split('=')[1])||null,verifyCsrf:()=>true,
    sessionCookies:()=>[],clearCookies:()=>[],revoke:async()=>{},revokeAll:async()=>{}};
  const api=createDashboardApi({auth,commands,
    identityRepository:{listLinkedAccounts:async()=>[],getTheme:async()=>'ghost-mint',getDefaultChain:async()=>null},
    supportedChains:SUPPORTED_CHAINS,loginRateLimiter:createCommandRateLimiter()});
  const app=express();app.use(express.json());app.use(api.securityHeaders);mountDashboardRoutes(app,api);app.use(api.error);
  const httpServer=http.createServer(app);await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>httpServer.close(resolve)));
  return {base:`http://127.0.0.1:${httpServer.address().port}`};
}
function headers(){return {cookie:'ghostmint_session=user','content-type':'application/json'};}

test('a non-owner session can read gas prices for a supported chain',async t=>{
  const {base}=await server(t,{owner:false});
  const response=await fetch(`${base}/api/gas/ethereum`,{headers:headers()});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.chain,'ethereum');
  assert.equal(body.safeGasPriceGwei,10);
  assert.equal(body.gasPriceGwei,12);
  assert.equal(body.maxFeePerGasGwei,15);
});

test('gas lookup rejects an unsupported chain the same way the bot command does',async t=>{
  const {base}=await server(t,{owner:false});
  const response=await fetch(`${base}/api/gas/dogecoin`,{headers:headers()});
  assert.equal(response.status,400);
  const body=await response.json();
  assert.match(JSON.stringify(body),/must be one of/);
});

test('a GasLookupError surfaces as a clear non-500 response without leaking a stack trace',async t=>{
  const {base}=await server(t,{owner:false});
  const missingKey=await fetch(`${base}/api/gas/missing-key`,{headers:headers()});
  assert.equal(missingKey.status,503);
  const missingKeyBody=await missingKey.json();
  assert.equal(missingKeyBody.code,'MISSING_API_KEY');
  assert.equal(missingKeyBody.error,'Gas lookup is unavailable until ETHERSCAN_API_KEY is configured');
  assert.equal('stack' in missingKeyBody,false);

  const providerDown=await fetch(`${base}/api/gas/provider-down`,{headers:headers()});
  assert.equal(providerDown.status,503);
  const providerDownBody=await providerDown.json();
  assert.equal(providerDownBody.code,'PROVIDER_ERROR');
  assert.equal('stack' in providerDownBody,false);
});

test('a non-owner session is rejected from social usage reporting',async t=>{
  const {base}=await server(t,{owner:false});
  const response=await fetch(`${base}/api/social-usage?period=month`,{headers:headers()});
  assert.equal(response.status,403);
  assert.deepEqual(await response.json(),{error:'Owner access required'});
});

test('an owner session gets the correct usage summary shape for both today and month',async t=>{
  const {base}=await server(t,{owner:true});
  for(const period of ['today','month']){
    const response=await fetch(`${base}/api/social-usage?period=${period}`,{headers:headers()});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.period,period);
    assert.equal(body.requests,42);
    assert.equal(Array.isArray(body.rows),true);
    assert.equal(body.rows[0].ruleName,'announcements');
    assert.equal(body.reportedCostUsd,1.23);
    assert.equal(body.reportedCredits,4.5);
    assert.equal(body.payPerUseEstimateUsd,2.1);
    assert.equal(typeof body.projectedMonthlyRequests,'number');
    assert.equal(Array.isArray(body.breakEvenRequests),true);
    assert.equal(body.breakEvenRequests[0].price,199);
  }
});

test('an invalid social usage period returns a clean 400 validation error, not a raw 500',async t=>{
  const {base}=await server(t,{owner:true});
  const response=await fetch(`${base}/api/social-usage?period=nonsense`,{headers:headers()});
  assert.equal(response.status,400);
  const body=await response.json();
  assert.equal(body.error,'Validation failed');
  assert.ok(Array.isArray(body.issues));
  assert.ok(body.issues.some(issue=>issue.field==='period'));
});

test('omitting the social usage period still defaults to month',async t=>{
  const {base}=await server(t,{owner:true});
  const response=await fetch(`${base}/api/social-usage`,{headers:headers()});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.period,'month');
});

test('the dashboard production bundle never contains the configured Etherscan API key',()=>{
  const root=path.join(__dirname,'..','public','dashboard');
  assert.equal(fs.existsSync(path.join(root,'index.html')),true,'dashboard must be built before tests');
  const content=fs.readdirSync(path.join(root,'assets')).map(name=>fs.readFileSync(path.join(root,'assets',name),'utf8')).join('\n');
  assert.equal(content.includes('ETHERSCAN_API_KEY'),false);
  const envPath=path.join(__dirname,'..','.env');
  if(fs.existsSync(envPath)){
    const values=require('dotenv').parse(fs.readFileSync(envPath));
    if(values.ETHERSCAN_API_KEY?.length>=8)assert.equal(content.includes(values.ETHERSCAN_API_KEY),false,'bundle contains the configured Etherscan API key');
  }
});
