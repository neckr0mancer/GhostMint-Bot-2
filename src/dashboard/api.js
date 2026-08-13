const {LinkCodeError}=require('../identity/identityService');
const {RateLimitError}=require('../security/botSecurity');
const SECURITY_HEADERS=Object.freeze({
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cross-Origin-Opener-Policy':'same-origin','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
});
function noStore(res){res.set('Cache-Control','no-store, private');}
function createDashboardApi({auth,identityRepository,loginRateLimiter}) {
  const requireSession=async(req,res,next)=>{try{const session=await auth.authenticate(req.headers.cookie);if(!session)return res.status(401).json({error:'Authentication required'});req.dashboardSession=session;next();}catch(error){next(error);}};
  const requireCsrf=(req,res,next)=>auth.verifyCsrf({session:req.dashboardSession,cookieHeader:req.headers.cookie,headerToken:req.get('x-csrf-token')})?next():res.status(403).json({error:'Invalid CSRF token'});
  return {securityHeaders(req,res,next){for(const [name,value] of Object.entries(SECURITY_HEADERS))res.set(name,value);if(req.path.startsWith('/api/'))noStore(res);next();},requireSession,requireCsrf,
    login:async(req,res)=>{noStore(res);try{loginRateLimiter.check('dashboard',req.ip||'unknown','login');const session=await auth.login(req.body?.code);res.setHeader('Set-Cookie',auth.sessionCookies(session));res.status(204).end();}
      catch(error){if(error instanceof LinkCodeError)return res.status(401).json({error:'Invalid or expired login code'});if(error instanceof RateLimitError){res.set('Retry-After',String(Math.ceil(error.retryAfterMs/1000)));return res.status(429).json({error:'Too many login attempts'});}throw error;}},
    logout:async(req,res)=>{noStore(res);await auth.revoke(req.dashboardSession);res.setHeader('Set-Cookie',auth.clearCookies());res.status(204).end();},
    logoutAll:async(req,res)=>{noStore(res);await auth.revokeAll(req.dashboardSession);res.setHeader('Set-Cookie',auth.clearCookies());res.status(204).end();},
    profile:async(req,res)=>{noStore(res);res.json({userId:req.dashboardSession.userId,linkedAccounts:await identityRepository.listLinkedAccounts(req.dashboardSession.userId)});},
  };
}
module.exports={SECURITY_HEADERS,createDashboardApi,noStore};
