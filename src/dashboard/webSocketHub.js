const {WebSocketServer}=require('ws');
const SESSION_EXPIRY_MESSAGES=Object.freeze({
  idle_expired:'Your session ended after 8 hours without dashboard activity.',
  absolute_expired:'Your session reached its 7-day maximum lifetime. Sign in again to continue.',
});
function sendPayloadSafely(socket,payload,log=()=>{}){
  if(socket.readyState!==socket.OPEN)return false;
  const report=error=>{if(!error)return;try{log(`WebSocket delivery failed safely: ${error.message}`);}catch{}};
  try{socket.send(payload,report);return true;}catch(error){report(error);return false;}
}
function createDashboardWebSocketHub({auth,log=()=>{},now=()=>Date.now(),setTimeoutFn=setTimeout,clearTimeoutFn=clearTimeout}) {const connections=new Map();const socketSessions=new Map();let server;
  function expiryFor(session){const timestamp=value=>value==null?Number.NaN:Number(value);
    const idle=timestamp(session?.expiresAt);const absolute=timestamp(session?.absoluteExpiresAt);
    const candidates=[['idle_expired',idle],['absolute_expired',absolute]].filter(([,value])=>Number.isFinite(value));
    if(!candidates.length)return null;
    return candidates.reduce((earliest,current)=>current[1]<earliest[1]?current:earliest);}
  function endSocket(socket,{reason,message}){
    sendPayloadSafely(socket,JSON.stringify({type:'session.ended',reason,message}),log);
    try{socket.close(4001,'Session ended');}catch(error){try{log('WebSocket close failed safely: '+error.message);}catch{}}
  }
  function scheduleExpiry(socket,session){const record=socketSessions.get(socket);if(!record)return;
    if(record.expiryTimer!==null)clearTimeoutFn(record.expiryTimer);
    const expiry=expiryFor(session);record.expiryTimer=null;
    if(!expiry)return;
    const [reason,expiresAt]=expiry;
    const timer=setTimeoutFn(()=>{
      // A successful HTTP request may have replaced this deadline after the callback was queued.
      // Ignore a stale callback even if a custom timer implementation invokes it after clear().
      if(record.expiryTimer!==timer)return;
      const values=connections.get(record.userId);values?.delete(socket);if(!values?.size)connections.delete(record.userId);
      endSocket(socket,{reason,message:SESSION_EXPIRY_MESSAGES[reason]});
    },Math.max(0,expiresAt-now()));
    record.expiryTimer=timer;
  }
  function add(session,socket){const {userId}=session;if(!connections.has(userId))connections.set(userId,new Set());connections.get(userId).add(socket);
    const record={userId,sessionId:session?.sessionId||null,expiryTimer:null};socketSessions.set(socket,record);
    scheduleExpiry(socket,session);
    socket.once('close',()=>{if(record.expiryTimer!==null)clearTimeoutFn(record.expiryTimer);socketSessions.delete(socket);const values=connections.get(userId);values?.delete(socket);if(!values?.size)connections.delete(userId);});}
  function refreshSession(session){if(!session?.sessionId)return false;let refreshed=false;
    for(const socket of connections.get(session.userId)||[]){const record=socketSessions.get(socket);
      if(record?.sessionId!==session.sessionId)continue;scheduleExpiry(socket,session);refreshed=true;}
    return refreshed;}
  function attach(httpServer){server=new WebSocketServer({server:httpServer,path:'/ws',verifyClient:async(info,done)=>{try{const session=await auth.authenticate(info.req.headers.cookie);if(!session)return done(false,401,'Authentication required');info.req.dashboardSession=session;done(true);}catch(error){log(`WebSocket authentication failed safely: ${error.message}`);done(false,401,'Authentication required');}}});
    server.on('connection',(socket,request)=>{add(request.dashboardSession,socket);socket.send(JSON.stringify({type:'connected'}));});return server;}
  function broadcastToUser(userId,message){const payload=JSON.stringify(message);for(const socket of connections.get(userId)||[])sendPayloadSafely(socket,payload,log);}
  // For notifying every currently-connected member of a set of users (e.g. every owner) about one
  // admin's write -- broadcastToUser alone only ever reaches the acting admin's own session.
  function broadcastToUsers(userIds,message){const payload=JSON.stringify(message);for(const userId of userIds)for(const socket of connections.get(userId)||[])sendPayloadSafely(socket,payload,log);}
  function disconnectUsers(userIds,{reason='revoked',message='Your session has ended. Sign in again to continue.'}={}){
    for(const userId of new Set(userIds)){
      const sockets=[...(connections.get(userId)||[])];
      connections.delete(userId);
      for(const socket of sockets){
        endSocket(socket,{reason,message});
      }
    }
  }
  async function close(){if(!server)return;for(const values of connections.values())for(const socket of values)socket.close(1001,'Server shutdown');await new Promise(resolve=>server.close(()=>resolve()));connections.clear();server=null;}
  return {attach,broadcastToUser,broadcastToUsers,disconnectUsers,refreshSession,close};
}
module.exports={createDashboardWebSocketHub,sendPayloadSafely};
