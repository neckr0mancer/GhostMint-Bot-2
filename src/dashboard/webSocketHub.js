const {WebSocketServer}=require('ws');
function sendPayloadSafely(socket,payload,log=()=>{}){
  if(socket.readyState!==socket.OPEN)return false;
  const report=error=>{if(!error)return;try{log(`WebSocket delivery failed safely: ${error.message}`);}catch{}};
  try{socket.send(payload,report);return true;}catch(error){report(error);return false;}
}
function createDashboardWebSocketHub({auth,log=()=>{}}) {const connections=new Map();let server;
  function add(userId,socket){if(!connections.has(userId))connections.set(userId,new Set());connections.get(userId).add(socket);socket.once('close',()=>{const values=connections.get(userId);values?.delete(socket);if(!values?.size)connections.delete(userId);});}
  function attach(httpServer){server=new WebSocketServer({server:httpServer,path:'/ws',verifyClient:async(info,done)=>{try{const session=await auth.authenticate(info.req.headers.cookie);if(!session)return done(false,401,'Authentication required');info.req.dashboardSession=session;done(true);}catch(error){log(`WebSocket authentication failed safely: ${error.message}`);done(false,401,'Authentication required');}}});
    server.on('connection',(socket,request)=>{add(request.dashboardSession.userId,socket);socket.send(JSON.stringify({type:'connected'}));});return server;}
  function broadcastToUser(userId,message){const payload=JSON.stringify(message);for(const socket of connections.get(userId)||[])sendPayloadSafely(socket,payload,log);}
  // For notifying every currently-connected member of a set of users (e.g. every owner) about one
  // admin's write -- broadcastToUser alone only ever reaches the acting admin's own session.
  function broadcastToUsers(userIds,message){const payload=JSON.stringify(message);for(const userId of userIds)for(const socket of connections.get(userId)||[])sendPayloadSafely(socket,payload,log);}
  function disconnectUsers(userIds,{reason='revoked',message='Your session has ended. Sign in again to continue.'}={}){
    const payload=JSON.stringify({type:'session.ended',reason,message});
    for(const userId of new Set(userIds)){
      const sockets=[...(connections.get(userId)||[])];
      connections.delete(userId);
      for(const socket of sockets){
        sendPayloadSafely(socket,payload,log);
        try{socket.close(4001,'Session ended');}catch(error){try{log(`WebSocket close failed safely: ${error.message}`);}catch{}}
      }
    }
  }
  async function close(){if(!server)return;for(const values of connections.values())for(const socket of values)socket.close(1001,'Server shutdown');await new Promise(resolve=>server.close(()=>resolve()));connections.clear();server=null;}
  return {attach,broadcastToUser,broadcastToUsers,disconnectUsers,close};
}
module.exports={createDashboardWebSocketHub,sendPayloadSafely};
