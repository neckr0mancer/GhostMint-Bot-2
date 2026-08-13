const {createHash,randomBytes,timingSafeEqual}=require('node:crypto');
const {Buffer}=require('node:buffer');
const SESSION_TTL_MS=8*60*60*1000;
const SESSION_COOKIE='ghostmint_session';
const CSRF_COOKIE='ghostmint_csrf';
function hash(value){return createHash('sha256').update(String(value)).digest('hex');}
function parseCookies(header=''){return Object.fromEntries(String(header).split(';').map(value=>value.trim()).filter(Boolean).map(value=>{const index=value.indexOf('=');return index<0?[value,'']:[value.slice(0,index),decodeURIComponent(value.slice(index+1))];}));}
function cookie(name,value,{httpOnly=false,maxAge}={}) {return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict${httpOnly?'; HttpOnly':''}`;}
function clearCookie(name,{httpOnly=false}={}){return cookie(name,'',{httpOnly,maxAge:0});}
function equalHash(value,expected){const actual=Buffer.from(hash(value));const wanted=Buffer.from(expected||'');return actual.length===wanted.length&&timingSafeEqual(actual,wanted);}
function createDashboardAuthService({identity,repository,now=()=>Date.now(),sessionTtlMs=SESSION_TTL_MS}) {
  async function login(code){const userId=await identity.consumeDashboardLinkCode(code);const token=randomBytes(32).toString('base64url');const csrfToken=randomBytes(32).toString('base64url');const expiresAt=now()+sessionTtlMs;
    const sessionId=await repository.create({userId,tokenHash:hash(token),csrfTokenHash:hash(csrfToken),expiresAt});return {sessionId,userId,token,csrfToken,expiresAt};}
  async function authenticate(cookieHeader){const token=parseCookies(cookieHeader)[SESSION_COOKIE];return token?repository.resolve(hash(token),now(),sessionTtlMs):null;}
  function verifyCsrf({session,cookieHeader,headerToken}){const cookieToken=parseCookies(cookieHeader)[CSRF_COOKIE];return Boolean(cookieToken&&headerToken&&cookieToken===headerToken&&equalHash(headerToken,session.csrfTokenHash));}
  function refreshSessionCookies(cookieHeader){const cookies=parseCookies(cookieHeader);const token=cookies[SESSION_COOKIE];const csrfToken=cookies[CSRF_COOKIE];if(!token||!csrfToken)return [];
    return [cookie(SESSION_COOKIE,token,{httpOnly:true,maxAge:Math.floor(sessionTtlMs/1000)}),cookie(CSRF_COOKIE,csrfToken,{maxAge:Math.floor(sessionTtlMs/1000)})];}
  return {authenticate,login,verifyCsrf,refreshSessionCookies,revoke:session=>repository.revoke(session.sessionId),revokeAll:session=>repository.revokeAll(session.userId),
    sessionCookies:session=>[cookie(SESSION_COOKIE,session.token,{httpOnly:true,maxAge:Math.floor(sessionTtlMs/1000)}),cookie(CSRF_COOKIE,session.csrfToken,{maxAge:Math.floor(sessionTtlMs/1000)})],
    clearCookies:()=>[clearCookie(SESSION_COOKIE,{httpOnly:true}),clearCookie(CSRF_COOKIE)]};
}
module.exports={CSRF_COOKIE,SESSION_COOKIE,SESSION_TTL_MS,createDashboardAuthService,parseCookies};
