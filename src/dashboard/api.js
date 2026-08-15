const {randomUUID}=require('node:crypto');
const {LinkCodeError}=require('../identity/identityService');
const {RateLimitError,requireTextConfirmation}=require('../security/botSecurity');
const {ValidationError,sendValidationError,requestSchemas}=require('../validation/domain');
const {AccountBlockedError,AuthorizationError}=require('../governance/governanceService');
const {GasLookupError}=require('../gas/etherscanGasService');
const SECURITY_HEADERS=Object.freeze({
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cross-Origin-Opener-Policy':'same-origin','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
});
function noStore(res){res.set('Cache-Control','no-store, private');}
function publicWallet(value){return {label:value.label,address:value.address,chain:value.chain,balance:value.balance??null,symbol:value.symbol??null,minted:value.minted??0};}
function jsonSafe(value){return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item));}

function createDashboardApi({auth,identityRepository,loginRateLimiter,commands,securityAudit={record:async()=>{}},broadcast=()=>{},supportedChains=[],now=()=>Date.now(),checkAccountStatus}) {
  const previews=new Map();
  const requireSession=async(req,res,next)=>{try{const session=await auth.authenticate(req.headers.cookie);if(!session)return res.status(401).json({error:'Authentication required'});
      if(typeof checkAccountStatus==='function'){try{await checkAccountStatus(session.userId);}catch(error){if(error instanceof AccountBlockedError)return res.status(403).json({error:error.message,code:error.code,status:error.status});throw error;}}
      req.dashboardSession=session;const refreshed=auth.refreshSessionCookies?.(req.headers.cookie);if(refreshed?.length)res.setHeader('Set-Cookie',refreshed);next();}catch(error){next(error);}};
  const requireCsrf=(req,res,next)=>auth.verifyCsrf({session:req.dashboardSession,cookieHeader:req.headers.cookie,headerToken:req.get('x-csrf-token')})?next():res.status(403).json({error:'Invalid CSRF token'});
  const action=handler=>async(req,res,next)=>{try{await handler(req,res);}catch(error){if(error instanceof ValidationError)return sendValidationError(res,error);if(error instanceof AuthorizationError)return res.status(403).json({error:'Owner access required'});next(error);}};
  function confirmation(req){requireTextConfirmation(req.body?.confirmation);}
  function issuePreview(userId,entries){const token=randomUUID();previews.set(token,{userId,entries,expiresAt:now()+5*60_000});return token;}
  function consumePreview(userId,token){const value=previews.get(String(token||''));previews.delete(String(token||''));if(!value||value.userId!==userId||value.expiresAt<=now())throw new ValidationError({field:'previewToken',message:'is invalid or expired'});return value;}
  const user=req=>req.dashboardSession.userId;
  const changed=(req,resource)=>broadcast(user(req),{type:`${resource}.changed`});
  const ADMIN_FIELDS=Object.freeze({
    'group-set':['name','maxWei','dailyWei','gasGwei','simulation'],
    'group-delete':['name'],'assign':['platform','platformUserId','group'],'unassign':['platform','platformUserId'],
    'user-ceilings':['platform','platformUserId','maxWei','dailyWei','gasGwei'],
    'user-ceilings-clear':['platform','platformUserId'],'user-simulation':['platform','platformUserId','simulation'],
    'group-simulation':['group','simulation'],'preset-set':['preset','simulation','confirmations','verification'],
    owner:['platform','platformUserId','enabled'],
    ban:['platform','platformUserId','reason'],unban:['platform','platformUserId','reason'],
    suspend:['platform','platformUserId','durationDays','reason'],unsuspend:['platform','platformUserId','reason'],
    deactivate:['platform','platformUserId','reason'],reactivate:['platform','platformUserId','reason'],
    subscription:['platform','platformUserId','active'],'good-standing':['platform','platformUserId','enabled'],
    'group-retention':['groupName','retentionPeriodDays','requireActiveSubscription','requireRecentActivityDays'],
    'schedule-removal':['platform','platformUserId','days'],
    'merge-account':['sourcePlatform','sourcePlatformUserId','targetPlatform','targetPlatformUserId'],
  });
  function adminInput(actionName,body={}){const fields=ADMIN_FIELDS[actionName];if(!fields)throw new ValidationError({field:'action',message:'is not supported'});return [actionName,...fields.map(field=>body[field])].join(' ');}
  async function auditAdminWrite(req,actionName){await Promise.resolve(securityAudit.record({userId:user(req),platform:'dashboard',
    contextId:req.dashboardSession.sessionId,command:`admin:${actionName}`,outcome:'success',reason:'Governance write completed'})).catch(()=>{});}

  return {securityHeaders(req,res,next){for(const [name,value] of Object.entries(SECURITY_HEADERS))res.set(name,value);if(req.path.startsWith('/api/'))noStore(res);next();},requireSession,requireCsrf,
    login:async(req,res)=>{noStore(res);try{loginRateLimiter.check('dashboard',req.ip||'unknown','login');const session=await auth.login(req.body?.code);res.setHeader('Set-Cookie',auth.sessionCookies(session));res.status(204).end();}
      catch(error){if(error instanceof LinkCodeError)return res.status(401).json({error:'Invalid or expired login code'});if(error instanceof RateLimitError){res.set('Retry-After',String(Math.ceil(error.retryAfterMs/1000)));return res.status(429).json({error:'Too many login attempts'});}throw error;}},
    logout:async(req,res)=>{noStore(res);await auth.revoke(req.dashboardSession);res.setHeader('Set-Cookie',auth.clearCookies());res.status(204).end();},
    logoutAll:async(req,res)=>{noStore(res);await auth.revokeAll(req.dashboardSession);res.setHeader('Set-Cookie',auth.clearCookies());res.status(204).end();},
    profile:async(req,res)=>{noStore(res);res.json({userId:user(req),isOwner:commands?.isOwner?await commands.isOwner(user(req)):false,linkedAccounts:await identityRepository.listLinkedAccounts(user(req)),supportedChains,theme:await identityRepository.getTheme(user(req)),defaultChain:identityRepository.getDefaultChain?await identityRepository.getDefaultChain(user(req)):null});},
    updateTheme:action(async(req,res)=>{const {theme}=requestSchemas.themeUpdate(req.body||{});res.json({theme:await identityRepository.setTheme(user(req),theme)});}),
    updateDefaultChain:action(async(req,res)=>{const {defaultChain}=requestSchemas.defaultChainUpdate(req.body||{},{supportedChains});res.json({defaultChain:await identityRepository.setDefaultChain(user(req),defaultChain)});}),
    gas:action(async(req,res)=>{noStore(res);
      try{res.json(await commands.gas(req.params.chain));}
      catch(error){
        if(error instanceof GasLookupError){const status=error.code==='UNSUPPORTED_CHAIN'?400:503;res.status(status).json({error:error.message,code:error.code});return;}
        throw error;
      }}),
    socialUsage:action(async(req,res)=>{noStore(res);const {period}=requestSchemas.socialUsagePeriod(req.query);res.json(jsonSafe(await commands.socialUsage(user(req),period)));}),
    linkCode:action(async(req,res)=>{noStore(res);res.json(await commands.linkCode(user(req)));}),
    wallets:action(async(req,res)=>{const values=commands.wallets(user(req));const settled=await Promise.allSettled(values.map(value=>commands.walletBalance(user(req),value.label)));res.json(settled.map((result,index)=>publicWallet(result.status==='fulfilled'?result.value:values[index])));}),
    createWallet:action(async(req,res)=>{const wallet=await commands.createWallet(user(req),req.body);changed(req,'wallets');res.status(201).json(publicWallet(wallet));}),
    importWallet:action(async(req,res)=>{const wallet=await commands.importWallet(user(req),req.body);changed(req,'wallets');res.status(201).json(publicWallet(wallet));}),
    removeWallet:action(async(req,res)=>{confirmation(req);await commands.removeWallet(user(req),req.params.label);changed(req,'wallets');res.status(204).end();}),
    mintPresets:action(async(req,res)=>res.json(jsonSafe(await commands.mintPresets(user(req))))),
    previewMint:action(async(req,res)=>{const labels=req.body.walletLabels||[req.body.walletLabel];const entries=[];for(const walletLabel of labels)entries.push(await commands.prepareMint(user(req),{...req.body,walletLabel}));const previewToken=issuePreview(user(req),entries);res.json({previewToken,expiresInSeconds:300,items:entries.map(value=>({wallet:value.wallet,preview:value.prepared.preview,simulation:jsonSafe(value.simulation)}))});}),
    confirmMint:action(async(req,res)=>{confirmation(req);const value=consumePreview(user(req),req.body.previewToken);const results=[];for(const entry of value.entries)results.push(await commands.submitPreparedMint(user(req),entry));res.status(202).json(jsonSafe({results}));}),
    tasks:action(async(req,res)=>res.json(await commands.tasksPage(user(req),req.query))),
    createTask:action(async(req,res)=>{const task=await commands.createTask(user(req),req.body);changed(req,'tasks');res.status(201).json(task);}),
    controlTask:action(async(req,res)=>{if(req.body?.action==='cancel')confirmation(req);const result=await commands.controlTask(user(req),req.body?.action,req.params.id);changed(req,'tasks');res.json(result);}),
    activity:action(async(req,res)=>res.json(jsonSafe(await commands.activityPage(user(req),req.query)))),
    pnl:action(async(req,res)=>res.json(await commands.pnl(user(req)))),
    addPnl:action(async(req,res)=>{const record=await commands.addPnl(user(req),req.body);changed(req,'pnl');res.status(201).json(record);}),
    updatePnl:action(async(req,res)=>{const record=await commands.updatePnl(user(req),req.params.id,req.body);changed(req,'pnl');res.json(record);}),
    deletePnl:action(async(req,res)=>{confirmation(req);await commands.deletePnl(user(req),req.params.id);changed(req,'pnl');res.status(204).end();}),
    snipers:action(async(req,res)=>{const [items,events]=await Promise.all([commands.snipers(user(req)),commands.sniperEvents(user(req))]);res.json(jsonSafe({items,events}));}),
    createSniper:action(async(req,res)=>{const sniper=await commands.createSniper(user(req),req.body);changed(req,'snipers');res.status(201).json(jsonSafe(sniper));}),
    updateSniper:action(async(req,res)=>{const sniper=await commands.updateSniper(user(req),req.params.id,req.body);changed(req,'snipers');res.json(jsonSafe(sniper));}),
    removeSniper:action(async(req,res)=>{confirmation(req);await commands.removeSniper(user(req),req.params.id);changed(req,'snipers');res.status(204).end();}),
    watchRules:action(async(req,res)=>{const [items,events]=await Promise.all([commands.watchRules(user(req)),commands.watchEvents(user(req))]);res.json({items,events});}),
    createWatchRule:action(async(req,res)=>{const rule=await commands.createWatchRule(user(req),req.body);changed(req,'watchrules');res.status(201).json(rule);}),
    updateWatchRule:action(async(req,res)=>{const rule=await commands.updateWatchRule(user(req),req.params.id,req.body);changed(req,'watchrules');res.json(rule);}),
    disableWatchRule:action(async(req,res)=>{const rule=await commands.disableWatchRule(user(req),req.params.id);changed(req,'watchrules');res.json(rule);}),
    removeWatchRule:action(async(req,res)=>{confirmation(req);await commands.removeWatchRule(user(req),req.params.id);changed(req,'watchrules');res.status(204).end();}),
    target:action(async(req,res)=>res.json(jsonSafe(await commands.targetDetails(user(req),req.query.type,req.params.id)))),
    updateTarget:action(async(req,res)=>res.json(jsonSafe(await commands.updateTargetPolicy(user(req),{...req.body,targetType:req.body.targetType,targetId:req.params.id})))),
    requestBypass:action(async(req,res)=>res.json(await commands.requestTargetBypass(user(req),{...req.body,targetId:req.params.id}))),
    confirmBypass:action(async(req,res)=>res.json(await commands.confirmTargetBypass(user(req),req.body))),
    applyPreset:action(async(req,res)=>res.json(await commands.applyTargetPreset(user(req),{...req.body,targetId:req.params.id}))),
    modePresets:action(async(req,res)=>res.json(await commands.modePresets())),
    pendingConfirmations:action(async(req,res)=>res.json(await commands.pendingConfirmations(user(req)))),
    resolveConfirmation:action(async(req,res)=>res.json(jsonSafe(await commands.confirmTrigger(user(req),req.params.id,req.body?.decision)))),
    adminOverview:action(async(req,res)=>res.json(jsonSafe(await commands.adminOverview(user(req))))),
    adminEffective:action(async(req,res)=>res.json(jsonSafe(await commands.adminEffective(user(req),req.query)))),
    adminWrite:action(async(req,res)=>{const actionName=String(req.params.action||'').toLowerCase();
      if(['group-delete','owner','ban','unban','suspend','unsuspend','deactivate','reactivate','merge-account'].includes(actionName))confirmation(req);
      let result;try{result=await commands.admin(user(req),adminInput(actionName,req.body));}
      catch(error){if(error instanceof AuthorizationError||error instanceof ValidationError)throw error;throw new ValidationError({field:'admin',message:error.message});}
      await auditAdminWrite(req,actionName);changed(req,'admin');res.json({message:result});}),
    error(error,req,res,next){if(res.headersSent)return next(error);res.status(500).json({error:'Request failed safely'});},
  };
}
function mountDashboardRoutes(app,api){
  app.post('/api/auth/login',api.login);
  app.post('/api/auth/logout',api.requireSession,api.requireCsrf,api.logout);
  app.post('/api/auth/logout-all',api.requireSession,api.requireCsrf,api.logoutAll);
  app.get('/api/profile',api.requireSession,api.profile);
  app.put('/api/profile/theme',api.requireSession,api.requireCsrf,api.updateTheme);
  app.put('/api/profile/default-chain',api.requireSession,api.requireCsrf,api.updateDefaultChain);
  app.get('/api/gas/:chain',api.requireSession,api.gas);
  app.get('/api/social-usage',api.requireSession,api.socialUsage);
  app.post('/api/auth/link-code',api.requireSession,api.requireCsrf,api.linkCode);
  app.get('/api/wallets',api.requireSession,api.wallets);
  app.post('/api/wallets/create',api.requireSession,api.requireCsrf,api.createWallet);
  app.post('/api/wallets/import',api.requireSession,api.requireCsrf,api.importWallet);
  app.delete('/api/wallets/:label',api.requireSession,api.requireCsrf,api.removeWallet);
  app.get('/api/mint-presets',api.requireSession,api.mintPresets);
  app.post('/api/mints/preview',api.requireSession,api.requireCsrf,api.previewMint);
  app.post('/api/mints/confirm',api.requireSession,api.requireCsrf,api.confirmMint);
  app.get('/api/tasks',api.requireSession,api.tasks);
  app.post('/api/tasks',api.requireSession,api.requireCsrf,api.createTask);
  app.post('/api/tasks/:id/control',api.requireSession,api.requireCsrf,api.controlTask);
  app.get('/api/activity',api.requireSession,api.activity);
  app.get('/api/pnl',api.requireSession,api.pnl);
  app.post('/api/pnl',api.requireSession,api.requireCsrf,api.addPnl);
  app.put('/api/pnl/:id',api.requireSession,api.requireCsrf,api.updatePnl);
  app.delete('/api/pnl/:id',api.requireSession,api.requireCsrf,api.deletePnl);
  app.get('/api/snipers',api.requireSession,api.snipers);
  app.post('/api/snipers',api.requireSession,api.requireCsrf,api.createSniper);
  app.put('/api/snipers/:id',api.requireSession,api.requireCsrf,api.updateSniper);
  app.delete('/api/snipers/:id',api.requireSession,api.requireCsrf,api.removeSniper);
  app.get('/api/watch-rules',api.requireSession,api.watchRules);
  app.post('/api/watch-rules',api.requireSession,api.requireCsrf,api.createWatchRule);
  app.put('/api/watch-rules/:id',api.requireSession,api.requireCsrf,api.updateWatchRule);
  app.post('/api/watch-rules/:id/disable',api.requireSession,api.requireCsrf,api.disableWatchRule);
  app.delete('/api/watch-rules/:id',api.requireSession,api.requireCsrf,api.removeWatchRule);
  app.get('/api/targets/:id',api.requireSession,api.target);
  app.put('/api/targets/:id',api.requireSession,api.requireCsrf,api.updateTarget);
  app.post('/api/targets/:id/bypass',api.requireSession,api.requireCsrf,api.requestBypass);
  app.post('/api/targets/bypass/confirm',api.requireSession,api.requireCsrf,api.confirmBypass);
  app.post('/api/targets/:id/preset',api.requireSession,api.requireCsrf,api.applyPreset);
  app.get('/api/mode-presets',api.requireSession,api.modePresets);
  app.get('/api/confirmations',api.requireSession,api.pendingConfirmations);
  app.post('/api/confirmations/:id',api.requireSession,api.requireCsrf,api.resolveConfirmation);
  app.get('/api/admin',api.requireSession,api.adminOverview);
  app.get('/api/admin/effective',api.requireSession,api.adminEffective);
  app.post('/api/admin/:action',api.requireSession,api.requireCsrf,api.adminWrite);
}
module.exports={SECURITY_HEADERS,createDashboardApi,jsonSafe,mountDashboardRoutes,noStore,publicWallet};
