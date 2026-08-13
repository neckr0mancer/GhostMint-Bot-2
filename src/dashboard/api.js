const {randomUUID}=require('node:crypto');
const {LinkCodeError}=require('../identity/identityService');
const {RateLimitError,requireTextConfirmation}=require('../security/botSecurity');
const {ValidationError,sendValidationError}=require('../validation/domain');
const SECURITY_HEADERS=Object.freeze({
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cross-Origin-Opener-Policy':'same-origin','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
});
function noStore(res){res.set('Cache-Control','no-store, private');}
function publicWallet(value){return {label:value.label,address:value.address,chain:value.chain,balance:value.balance??null,symbol:value.symbol??null,minted:value.minted??0};}
function jsonSafe(value){return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item));}

function createDashboardApi({auth,identityRepository,loginRateLimiter,commands,supportedChains=[],now=()=>Date.now()}) {
  const previews=new Map();
  const requireSession=async(req,res,next)=>{try{const session=await auth.authenticate(req.headers.cookie);if(!session)return res.status(401).json({error:'Authentication required'});req.dashboardSession=session;next();}catch(error){next(error);}};
  const requireCsrf=(req,res,next)=>auth.verifyCsrf({session:req.dashboardSession,cookieHeader:req.headers.cookie,headerToken:req.get('x-csrf-token')})?next():res.status(403).json({error:'Invalid CSRF token'});
  const action=handler=>async(req,res,next)=>{try{await handler(req,res);}catch(error){if(error instanceof ValidationError)return sendValidationError(res,error);next(error);}};
  function confirmation(req){requireTextConfirmation(req.body?.confirmation);}
  function issuePreview(userId,entries){const token=randomUUID();previews.set(token,{userId,entries,expiresAt:now()+5*60_000});return token;}
  function consumePreview(userId,token){const value=previews.get(String(token||''));previews.delete(String(token||''));if(!value||value.userId!==userId||value.expiresAt<=now())throw new ValidationError({field:'previewToken',message:'is invalid or expired'});return value;}
  const user=req=>req.dashboardSession.userId;

  return {securityHeaders(req,res,next){for(const [name,value] of Object.entries(SECURITY_HEADERS))res.set(name,value);if(req.path.startsWith('/api/'))noStore(res);next();},requireSession,requireCsrf,
    login:async(req,res)=>{noStore(res);try{loginRateLimiter.check('dashboard',req.ip||'unknown','login');const session=await auth.login(req.body?.code);res.setHeader('Set-Cookie',auth.sessionCookies(session));res.status(204).end();}
      catch(error){if(error instanceof LinkCodeError)return res.status(401).json({error:'Invalid or expired login code'});if(error instanceof RateLimitError){res.set('Retry-After',String(Math.ceil(error.retryAfterMs/1000)));return res.status(429).json({error:'Too many login attempts'});}throw error;}},
    logout:async(req,res)=>{noStore(res);await auth.revoke(req.dashboardSession);res.setHeader('Set-Cookie',auth.clearCookies());res.status(204).end();},
    logoutAll:async(req,res)=>{noStore(res);await auth.revokeAll(req.dashboardSession);res.setHeader('Set-Cookie',auth.clearCookies());res.status(204).end();},
    profile:async(req,res)=>{noStore(res);res.json({userId:user(req),linkedAccounts:await identityRepository.listLinkedAccounts(user(req)),supportedChains});},
    wallets:action(async(req,res)=>{const values=commands.wallets(user(req));const settled=await Promise.allSettled(values.map(value=>commands.walletBalance(user(req),value.label)));res.json(settled.map((result,index)=>publicWallet(result.status==='fulfilled'?result.value:values[index])));}),
    createWallet:action(async(req,res)=>res.status(201).json(publicWallet(await commands.createWallet(user(req),req.body)))),
    importWallet:action(async(req,res)=>res.status(201).json(publicWallet(await commands.importWallet(user(req),req.body)))),
    removeWallet:action(async(req,res)=>{confirmation(req);await commands.removeWallet(user(req),req.params.label);res.status(204).end();}),
    mintPresets:action(async(req,res)=>res.json(jsonSafe(await commands.mintPresets(user(req))))),
    previewMint:action(async(req,res)=>{const labels=req.body.walletLabels||[req.body.walletLabel];const entries=[];for(const walletLabel of labels)entries.push(await commands.prepareMint(user(req),{...req.body,walletLabel}));const previewToken=issuePreview(user(req),entries);res.json({previewToken,expiresInSeconds:300,items:entries.map(value=>({wallet:value.wallet,preview:value.prepared.preview,simulation:jsonSafe(value.simulation)}))});}),
    confirmMint:action(async(req,res)=>{confirmation(req);const value=consumePreview(user(req),req.body.previewToken);const results=[];for(const entry of value.entries)results.push(await commands.submitPreparedMint(user(req),entry));res.status(202).json(jsonSafe({results}));}),
    tasks:action(async(req,res)=>res.json(await commands.tasksPage(user(req),req.query))),
    createTask:action(async(req,res)=>res.status(201).json(await commands.createTask(user(req),req.body))),
    controlTask:action(async(req,res)=>{if(req.body?.action==='cancel')confirmation(req);res.json(await commands.controlTask(user(req),req.body?.action,req.params.id));}),
    activity:action(async(req,res)=>res.json(jsonSafe(await commands.activityPage(user(req),req.query)))),
    pnl:action(async(req,res)=>res.json(await commands.pnl(user(req)))),
    addPnl:action(async(req,res)=>res.status(201).json(await commands.addPnl(user(req),req.body))),
    updatePnl:action(async(req,res)=>res.json(await commands.updatePnl(user(req),req.params.id,req.body))),
    deletePnl:action(async(req,res)=>{confirmation(req);await commands.deletePnl(user(req),req.params.id);res.status(204).end();}),
    error(error,req,res,next){if(res.headersSent)return next(error);res.status(500).json({error:'Request failed safely'});},
  };
}
function mountDashboardRoutes(app,api){
  app.post('/api/auth/login',api.login);
  app.post('/api/auth/logout',api.requireSession,api.requireCsrf,api.logout);
  app.post('/api/auth/logout-all',api.requireSession,api.requireCsrf,api.logoutAll);
  app.get('/api/profile',api.requireSession,api.profile);
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
}
module.exports={SECURITY_HEADERS,createDashboardApi,jsonSafe,mountDashboardRoutes,noStore,publicWallet};
