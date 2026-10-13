const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createWalletHistoryRepository } = require('../src/walletHistory/repository');

const USER = '11111111-1111-4111-8111-111111111111';
const ADDRESS = '0x00000000000000000000000000000000000000a7';

test('migration and repository define recoverable ownership-guarded leases', () => {
  const migration = fs.readFileSync(path.join(__dirname,'..','migrations',
    '073_wallet_history_foundation.sql'),'utf8');
  assert.match(migration,/claimed_by TEXT/);
  assert.match(migration,/claimed_at TIMESTAMPTZ/);
  assert.match(migration,/lease_expires_at TIMESTAMPTZ/);
  assert.match(migration,/state IN \('queued','backfilling','error'\)/);
  const source = fs.readFileSync(path.join(__dirname,'..','src','walletHistory','repository.js'),'utf8');
  assert.match(source,/FOR UPDATE OF sync SKIP LOCKED LIMIT 1/);
  assert.match(source,/sync\.state='error' AND sync\.retry_after IS NOT NULL/);
  assert.match(source,/claimed_by=\$7 AND lease_expires_at>NOW\(\)/);
  assert.match(source,/claimed_by=\$10 AND lease_expires_at>NOW\(\)/);
});

test('claimDue maps one lease and starts a queued generation atomically', async () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const calls = [];
  const pool = { query:async (sql,params) => {
    calls.push({sql,params});
    return {rowCount:1,rows:[{
      user_id:USER,chain:'ethereum',wallet_address:ADDRESS,provider_key:'goldrush',
      state:'backfilling',cursor:null,generation:'4',attempts:2,
      claimed_by:'worker-a',claimed_at:new Date(now),
      lease_expires_at:new Date(now+30_000),
    }]};
  } };
  const claim = await createWalletHistoryRepository(pool).claimDue({
    workerId:'Worker-A',now,leaseMs:30_000,
  });
  assert.equal(claim.userId,USER);
  assert.equal(claim.claimedBy,'worker-a');
  assert.equal(claim.generation,4);
  assert.deepEqual(calls[0].params,['worker-a',now,30_000]);
  assert.match(calls[0].sql,/CASE WHEN sync\.state='queued' THEN sync\.generation\+1/);
  assert.match(calls[0].sql,/claimed_by IS NULL OR sync\.lease_expires_at<=/);
});

test('releaseClaim is scoped to the exact account, chain, address, and owner', async () => {
  const calls=[];
  const pool={query:async(sql,params)=>{
    calls.push({sql,params});
    return {rowCount:0,rows:[]};
  }};
  const released=await createWalletHistoryRepository(pool).releaseClaim({
    userId:USER,chain:'ethereum',walletAddress:ADDRESS,workerId:'worker-a',
  });
  assert.equal(released,null);
  assert.deepEqual(calls[0].params,[USER,'ethereum',ADDRESS,'worker-a']);
  assert.match(calls[0].sql,/wallet_address=\$3 AND claimed_by=\$4/);
});
