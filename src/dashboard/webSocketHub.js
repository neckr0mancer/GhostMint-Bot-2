const {WebSocketServer}=require('ws');
function createDashboardWebSocketHub({auth,log=()=>{}}) {const connections=new Map();let server;
  function add(userId,socket){if(!connections.has(userId))connections.set(userId,new Set());connections.get(userId).add(socket);socket.once('close',()=>{const values=connections.get(userId);values?.delete(socket);if(!values?.size)connections.delete(userId);});}
  function attach(httpServer){server=new WebSocketServer({server:httpServer,path:'/ws',verifyClient:async(info,done)=>{try{const session=await auth.authenticate(info.req.headers.cookie);if(!session)return done(false,401,'Authentication required');info.req.dashboardSession=session;done(true);}catch(error){log(`WebSocket authentication failed safely: ${error.message}`);done(false,401,'Authentication required');}}});
    server.on('connection',(socket,request)=>{add(request.dashboardSession.userId,socket);socket.send(JSON.stringify({type:'connected'}));});return server;}
  function broadcastToUser(userId,message){const payload=JSON.stringify(message);for(const socket of connections.get(userId)||[])if(socket.readyState===socket.OPEN)socket.send(payload);}
  async function close(){if(!server)return;for(const values of connections.values())for(const socket of values)socket.close(1001,'Server shutdown');await new Promise(resolve=>server.close(()=>resolve()));connections.clear();server=null;}
  return {attach,broadcastToUser,close};
}
module.exports={createDashboardWebSocketHub};
