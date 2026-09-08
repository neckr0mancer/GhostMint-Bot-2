const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {setImmediate}=require('node:timers');
const test=require('node:test');
const {createAlchemyPendingSource,normalizeTransaction,supportsAlchemyPendingSource}=require('../src/sniper/alchemyPendingSource');

class FakeSocket extends EventEmitter{
  static OPEN=1;
  static instances=[];
  constructor(url){super();this.url=url;this.readyState=FakeSocket.OPEN;this.sent=[];FakeSocket.instances.push(this);}
  send(value){this.sent.push(JSON.parse(value));}
  close(){this.readyState=3;}
}

const WS='wss://eth-mainnet.g.alchemy.com/v2/not-a-real-key';
const TARGET='0x0000000000000000000000000000000000000011';
const HASH=`0x${'12'.repeat(32)}`;

test('Alchemy pending source subscribes with a narrow sender filter and emits full normalized transactions',async()=>{
  FakeSocket.instances=[];const received=[];
  const source=createAlchemyPendingSource({chain:'ethereum',wsUrl:WS,targets:[TARGET],WebSocketImpl:FakeSocket,
    onTransaction:tx=>received.push(tx)});
  source.start();const socket=FakeSocket.instances[0];socket.emit('open');
  assert.deepEqual(socket.sent[0].params,['alchemy_pendingTransactions',{fromAddress:[TARGET],hashesOnly:false}]);
  socket.emit('message',JSON.stringify({jsonrpc:'2.0',id:socket.sent[0].id,result:'sub-1'}));
  socket.emit('message',JSON.stringify({jsonrpc:'2.0',method:'eth_subscription',params:{subscription:'sub-1',result:{
    hash:HASH,from:TARGET,to:'0x0000000000000000000000000000000000000022',input:'0x1234',
    value:'0x2',nonce:'0x3',gas:'0x5208',gasPrice:'0x4',
  }}}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(received.length,1);assert.equal(received[0].data,'0x1234');assert.equal(received[0].value,2n);
  assert.equal(received[0].nonce,'3');assert.equal(source.health().received,1);
  source.stop();
});

test('unsupported or non-Alchemy WebSockets are not advertised as pending-capable',()=>{
  assert.equal(supportsAlchemyPendingSource('ethereum',WS),true);
  assert.equal(supportsAlchemyPendingSource('base','wss://base-mainnet.g.alchemy.com/v2/key'),false);
  assert.equal(supportsAlchemyPendingSource('ethereum','wss://example.com/ws'),false);
  assert.throws(()=>createAlchemyPendingSource({chain:'base',wsUrl:'wss://base-mainnet.g.alchemy.com/v2/key',
    targets:[TARGET],onTransaction:()=>{},WebSocketImpl:FakeSocket}),/not supported/);
});

test('transaction normalizer refuses malformed quantities instead of inventing values',()=>{
  const normalized=normalizeTransaction({hash:HASH,from:TARGET,to:TARGET,input:'0x1234',value:'bad',nonce:'bad'});
  assert.equal(normalized,null);
});

test('large target sets are split into provider-safe subscriptions and all must connect',()=>{
  FakeSocket.instances=[];
  const targets=Array.from({length:1001},(_,index)=>`0x${BigInt(index+1).toString(16).padStart(40,'0')}`);
  const source=createAlchemyPendingSource({chain:'ethereum',wsUrl:WS,targets,WebSocketImpl:FakeSocket,
    onTransaction:()=>{}});
  source.start();const socket=FakeSocket.instances[0];socket.emit('open');
  assert.equal(socket.sent.length,2);
  assert.equal(socket.sent[0].params[1].fromAddress.length,1000);
  assert.equal(socket.sent[1].params[1].fromAddress.length,1);
  socket.emit('message',JSON.stringify({id:socket.sent[0].id,result:'sub-1'}));
  assert.equal(source.health().connected,false);
  socket.emit('message',JSON.stringify({id:socket.sent[1].id,result:'sub-2'}));
  assert.equal(source.health().connected,true);
  source.stop();
});

test('transient subscription refusal reconnects while unsupported methods fail closed',()=>{
  FakeSocket.instances=[];
  const transient=createAlchemyPendingSource({chain:'ethereum',wsUrl:WS,targets:[TARGET],WebSocketImpl:FakeSocket,
    reconnectDelayMs:60_000,onTransaction:()=>{}});
  transient.start();let socket=FakeSocket.instances[0];socket.emit('open');
  socket.emit('message',JSON.stringify({id:socket.sent[0].id,error:{code:429,message:'rate limited'}}));
  assert.equal(transient.health().incompatible,false);
  assert.equal(transient.health().connected,false);
  transient.stop();

  const unsupported=createAlchemyPendingSource({chain:'ethereum',wsUrl:WS,targets:[TARGET],WebSocketImpl:FakeSocket,
    onTransaction:()=>{}});
  unsupported.start();socket=FakeSocket.instances.at(-1);socket.emit('open');
  socket.emit('message',JSON.stringify({id:socket.sent[0].id,error:{code:-32601,message:'method not found'}}));
  assert.equal(unsupported.health().incompatible,true);
  unsupported.stop();
});
