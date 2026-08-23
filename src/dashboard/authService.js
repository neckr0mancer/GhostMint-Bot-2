const {createHash,randomBytes,timingSafeEqual}=require('node:crypto');
const {Buffer}=require('node:buffer');
const SESSION_TTL_MS=8*60*60*1000;
// Absolute cap on session lifetime, independent of activity. SESSION_TTL_MS alone is a sliding idle
// timeout (see sessionRepository.resolve) -- without this, a session that's used at least once every
// 8 hours never actually expires, which is exactly the "logged in for days" report this fixes.
const SESSION_MAX_LIFETIME_MS=7*24*60*60*1000;
const MAX_ACTIVE_SESSIONS=3;
const SESSION_COOKIE='ghostmint_session';
const CSRF_COOKIE='ghostmint_csrf';
function hash(value){return createHash('sha256').update(String(value)).digest('hex');}
function parseCookies(header=''){return Object.fromEntries(String(header).split(';').map(value=>value.trim()).filter(Boolean).map(value=>{const index=value.indexOf('=');return index<0?[value,'']:[value.slice(0,index),decodeURIComponent(value.slice(index+1))];}));}
function cookie(name,value,{httpOnly=false,maxAge,secure=true}={}) {return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}; SameSite=Strict${httpOnly?'; HttpOnly':''}`;}
function clearCookie(name,{httpOnly=false,secure=true}={}){return cookie(name,'',{httpOnly,maxAge:0,secure});}
function equalHash(value,expected){const actual=Buffer.from(hash(value));const wanted=Buffer.from(expected||'');return actual.length===wanted.length&&timingSafeEqual(actual,wanted);}
function createDashboardAuthService({identity,repository,now=()=>Date.now(),sessionTtlMs=SESSION_TTL_MS,sessionMaxLifetimeMs=SESSION_MAX_LIFETIME_MS,maxActiveSessions=MAX_ACTIVE_SESSIONS,secureCookies=true}) {
  // Shared by both login paths -- session creation itself has no notion of how the userId was
  // resolved (a redeemed Telegram/Discord link code, or a verified username+password pair), so
  // there is exactly one place a session gets minted.
  async function createSession(userId,clientLabel=null){const token=randomBytes(32).toString('base64url');const csrfToken=randomBytes(32).toString('base64url');const expiresAt=now()+sessionTtlMs;
    const sessionId=await repository.create({userId,tokenHash:hash(token),csrfTokenHash:hash(csrfToken),expiresAt,maxActiveSessions,clientLabel,now:now(),maxLifetimeMs:sessionMaxLifetimeMs});return {sessionId,userId,token,csrfToken,expiresAt};}
  async function login(code,clientLabel){const userId=await identity.consumeDashboardLinkCode(code);return createSession(userId,clientLabel);}
  async function authenticateDetailed(cookieHeader){const token=parseCookies(cookieHeader)[SESSION_COOKIE];if(!token)return {session:null,reason:'cookie_missing'};
    const tokenHash=hash(token);const session=await repository.resolve(tokenHash,now(),sessionTtlMs,sessionMaxLifetimeMs);
    if(session)return {session,reason:null};
    return {session:null,reason:typeof repository.denialReason==='function'?await repository.denialReason(tokenHash,now(),sessionMaxLifetimeMs):'invalid'};
  }
  async function authenticate(cookieHeader){return (await authenticateDetailed(cookieHeader)).session;}
  function verifyCsrf({session,cookieHeader,headerToken}){const cookieToken=parseCookies(cookieHeader)[CSRF_COOKIE];return Boolean(cookieToken&&headerToken&&cookieToken===headerToken&&equalHash(headerToken,session.csrfTokenHash));}
  function refreshSessionCookies(cookieHeader){const cookies=parseCookies(cookieHeader);const token=cookies[SESSION_COOKIE];const csrfToken=cookies[CSRF_COOKIE];if(!token||!csrfToken)return [];
    return [cookie(SESSION_COOKIE,token,{httpOnly:true,maxAge:Math.floor(sessionTtlMs/1000),secure:secureCookies}),cookie(CSRF_COOKIE,csrfToken,{maxAge:Math.floor(sessionTtlMs/1000),secure:secureCookies})];}
  return {authenticate,authenticateDetailed,login,loginWithUserId:createSession,verifyCsrf,refreshSessionCookies,
    sessionSummary:async session=>({...(typeof repository.summary==='function'?await repository.summary(session.userId,session.sessionId,now(),sessionMaxLifetimeMs):{activeCount:1,expiresAt:session.expiresAt}),idleTimeoutMs:sessionTtlMs,maxLifetimeMs:sessionMaxLifetimeMs,maxActiveSessions}),
    revoke:session=>repository.revoke(session.sessionId,'logout'),revokeAll:session=>repository.revokeAll(session.userId,'logout_all'),
    sessionCookies:session=>[cookie(SESSION_COOKIE,session.token,{httpOnly:true,maxAge:Math.floor(sessionTtlMs/1000),secure:secureCookies}),cookie(CSRF_COOKIE,session.csrfToken,{maxAge:Math.floor(sessionTtlMs/1000),secure:secureCookies})],
    clearCookies:()=>[clearCookie(SESSION_COOKIE,{httpOnly:true,secure:secureCookies}),clearCookie(CSRF_COOKIE,{secure:secureCookies})]};
}
module.exports={CSRF_COOKIE,SESSION_COOKIE,SESSION_TTL_MS,SESSION_MAX_LIFETIME_MS,MAX_ACTIVE_SESSIONS,createDashboardAuthService,parseCookies};
