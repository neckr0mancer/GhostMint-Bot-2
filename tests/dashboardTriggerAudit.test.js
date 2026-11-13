const assert=require('node:assert/strict');
const http=require('node:http');
const test=require('node:test');
const express=require('express');
const {createDashboardApi,mountDashboardRoutes}=require('../src/dashboard/api');

test('dashboard trigger audit is authenticated, tenant scoped, read only, and query forwarded',async t=>{
  const calls=[];
  const auth={
    authenticate:async header=>{
      const token=String(header||'').split('=')[1];
      return token?{userId:token==='token-b'?'user-b':'user-a'}:null;
    },
    verifyCsrf:()=>false,
  };
  const commands={triggerAuditPage:async(userId,input)=>{
    calls.push({userId,input});
    return {page:Number(input.page),pageSize:Number(input.pageSize),total:1,totalPages:1,
      hasNext:false,hasPrevious:true,items:[{auditId:'1',userId,triggerSource:'social-triggered'}]};
  }};
  const api=createDashboardApi({auth,identityRepository:{},commands});
  const app=express();
  app.use(api.securityHeaders);
  mountDashboardRoutes(app,api);
  app.use(api.error);
  const server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const path='/api/history/trigger-audit?page=2&pageSize=5&search=0xabc';
  assert.equal((await fetch(base+path)).status,401);
  const response=await fetch(base+path,{headers:{cookie:'ghostmint_session=token-a'}});
  assert.equal(response.status,200);
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.deepEqual(await response.json(),{page:2,pageSize:5,total:1,totalPages:1,
    hasNext:false,hasPrevious:true,items:[{auditId:'1',userId:'user-a',triggerSource:'social-triggered'}]});
  const other=await fetch(base+path,{headers:{cookie:'ghostmint_session=token-b'}});
  assert.equal(other.status,200);
  assert.deepEqual(calls,[
    {userId:'user-a',input:{page:'2',pageSize:'5',search:'0xabc'}},
    {userId:'user-b',input:{page:'2',pageSize:'5',search:'0xabc'}},
  ]);
});
