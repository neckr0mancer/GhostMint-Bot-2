const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const test=require('node:test');
const {ACCOUNT_MERGE_GUARD_DOMAINS}=require('../src/identity/accountMergePlan');
const {createPostgresIdentityRepository}=require('../src/identity/postgresIdentityRepository');

function result(rows=[]){return {rowCount:rows.length,rows};}

function ownershipFingerprints({source={},target={}}={}){
  const rows=[];
  for(const side of ['source','target']){
    const overrides=side==='source'?source:target;
    for(const domain of ACCOUNT_MERGE_GUARD_DOMAINS){
      const value=overrides[domain]||{};
      const seed=value.seed||`${side}:${domain}:empty`;
      rows.push({domain,side,row_count:value.count||0,
        fingerprint:`sha256:${createHash('sha256').update(seed).digest('hex')}`});
    }
  }
  return rows;
}

function raceFixture({initialLinkedUserId=null,confirmedUserId,targetPlatformUserId}){
  const queries=[];
  const calls=[];
  let platformLookupCount=0;
  let released=false;
  const client={
    async query(sql,params=[]){
      const normalized=String(sql).replace(/\s+/g,' ').trim();
      queries.push(normalized);
      calls.push({sql:normalized,params});
      if(normalized==='BEGIN'||normalized==='COMMIT'||normalized==='ROLLBACK')return result();
      if(normalized.startsWith('SELECT user_id FROM account_link_codes'))return result([{user_id:'target-user'}]);
      if(normalized.startsWith('SELECT user_id FROM linked_accounts WHERE platform=$1')){
        platformLookupCount+=1;
        if(platformLookupCount===1){
          return initialLinkedUserId?result([{user_id:initialLinkedUserId}]):result();
        }
        return confirmedUserId?result([{user_id:confirmedUserId}]):result();
      }
      if(normalized.startsWith('INSERT INTO linked_accounts'))return result();
      if(normalized.startsWith('SELECT platform_user_id FROM linked_accounts WHERE user_id=$1')){
        return targetPlatformUserId?result([{platform_user_id:targetPlatformUserId}]):result();
      }
      if(normalized.startsWith('UPDATE account_link_codes SET used_at=NOW()'))return result([{user_id:'target-user'}]);
      throw new Error(`Unexpected query: ${normalized}`);
    },
    release(){released=true;},
  };
  return {queries,calls,released:()=>released,
    repository:createPostgresIdentityRepository({connect:async()=>client})};
}

test('link-code consumption never reports success when bot-first account creation wins the race',async()=>{
  const {queries,calls,released,repository}=raceFixture({
    confirmedUserId:'source-user',
    targetPlatformUserId:null,
  });
  const outcome=await repository.consumeLinkCode({
    codeHash:'code-hash',platform:'discord',platformUserId:'discord-1',now:Date.now(),
  });
  assert.deepEqual(outcome,{status:'conflict'});
  assert.equal(queries.includes('ROLLBACK'),true);
  assert.equal(queries.some(value=>value.startsWith('UPDATE account_link_codes SET used_at=NOW()')),false,
    'the one-time code must remain unused after a raced identity conflict');
  assert.equal(queries.includes('COMMIT'),false);
  assert.deepEqual(calls.find(call=>call.sql.startsWith('INSERT INTO linked_accounts')).params,
    ['target-user','discord','discord-1']);
  assert.equal(released(),true);
});

test('link-code consumption accepts a concurrent insert only when it created the intended mapping',async()=>{
  const {queries,calls,released,repository}=raceFixture({
    confirmedUserId:'target-user',
    targetPlatformUserId:'discord-1',
  });
  const outcome=await repository.consumeLinkCode({
    codeHash:'code-hash',platform:'discord',platformUserId:'discord-1',now:Date.now(),
  });
  assert.deepEqual(outcome,{status:'linked',userId:'target-user'});
  assert.equal(queries.some(value=>value.startsWith('UPDATE account_link_codes SET used_at=NOW()')),true);
  assert.equal(queries.includes('COMMIT'),true);
  assert.equal(queries.includes('ROLLBACK'),false);
  assert.deepEqual(calls.find(call=>call.sql.startsWith('SELECT platform_user_id FROM linked_accounts')).params,
    ['target-user','discord']);
  assert.equal(released(),true);
});

test('link-code consumption keeps an existing correct mapping linked',async()=>{
  const {queries,released,repository}=raceFixture({
    initialLinkedUserId:'target-user',
    confirmedUserId:'target-user',
    targetPlatformUserId:'discord-1',
  });
  const outcome=await repository.consumeLinkCode({
    codeHash:'code-hash',platform:'discord',platformUserId:'discord-1',now:Date.now(),
  });
  assert.deepEqual(outcome,{status:'linked',userId:'target-user'});
  assert.equal(queries.includes('COMMIT'),true);
  assert.equal(released(),true);
});

test('link-code consumption leaves the code unused when the identity already belongs to another user',async()=>{
  const {queries,released,repository}=raceFixture({
    initialLinkedUserId:'source-user',
  });
  const outcome=await repository.consumeLinkCode({
    codeHash:'code-hash',platform:'discord',platformUserId:'discord-1',now:Date.now(),
  });
  assert.deepEqual(outcome,{status:'conflict'});
  assert.equal(queries.some(value=>value.startsWith('INSERT INTO linked_accounts')),false);
  assert.equal(queries.some(value=>value.startsWith('UPDATE account_link_codes SET used_at=NOW()')),false);
  assert.equal(queries.includes('ROLLBACK'),true);
  assert.equal(released(),true);
});

test('link-code consumption leaves the code unused when the target already has another identity on that platform',async()=>{
  const {queries,released,repository}=raceFixture({
    confirmedUserId:null,
    targetPlatformUserId:'discord-other',
  });
  const outcome=await repository.consumeLinkCode({
    codeHash:'code-hash',platform:'discord',platformUserId:'discord-1',now:Date.now(),
  });
  assert.deepEqual(outcome,{status:'conflict'});
  assert.equal(queries.some(value=>value.startsWith('UPDATE account_link_codes SET used_at=NOW()')),false);
  assert.equal(queries.includes('ROLLBACK'),true);
  assert.equal(released(),true);
});

function previewFixture({graphRows, schemaCurrent=true}={}){
  const queries=[];let released=false;
  const ownershipRows=graphRows || ownershipFingerprints({
    source:{users:{count:1},wallets:{count:1}},target:{users:{count:1}},
  });
  const client={
    async query(sql){
      const normalized=String(sql).replace(/\s+/g,' ').trim();queries.push(normalized);
      if(['BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY','COMMIT','ROLLBACK'].includes(normalized))return result();
      if(normalized.startsWith('SELECT filename FROM schema_migrations'))return schemaCurrent
        ?result([{filename:'072_account_merge_ownership_fks.sql'}]):result();
      if(normalized.startsWith('SELECT platform,platform_user_id,user_id FROM linked_accounts'))return result([
        {platform:'discord',platform_user_id:'discord-1',user_id:'source-user'},
        {platform:'telegram',platform_user_id:'telegram-1',user_id:'target-user'},
      ]);
      if(normalized.startsWith('SELECT user_id,created_at,is_owner'))return result([
        {user_id:'source-user',created_at:new Date('2026-01-01T00:00:00Z'),is_owner:false,is_root_owner:false,
          account_status:'active',status_reason:null,status_changed_at:null,suspended_until:null,
          subscription_active:false,good_standing_override:false,dashboard_theme:'ghost-mint',default_chain:null,
          low_balance_threshold_native:'0.01',sniper_observation_default:'confirmed',display_currency:'USD',
          time_format:'24h',username:null,security_password_hash:null,display_name:null,bot_gate_level:'off',bot_gate_skip_mint:false},
        {user_id:'target-user',created_at:new Date('2025-01-01T00:00:00Z'),is_owner:false,is_root_owner:false,
          account_status:'active',status_reason:null,status_changed_at:null,suspended_until:null,
          subscription_active:false,good_standing_override:false,dashboard_theme:'ghost-mint',default_chain:null,
          low_balance_threshold_native:'0.01',sniper_observation_default:'confirmed',display_currency:'USD',
          time_format:'24h',username:null,security_password_hash:null,display_name:null,bot_gate_level:'off',bot_gate_skip_mint:false},
      ]);
      if(normalized.startsWith('SELECT user_id,platform,platform_user_id FROM linked_accounts'))return result([
        {user_id:'source-user',platform:'discord',platform_user_id:'discord-1'},
        {user_id:'target-user',platform:'telegram',platform_user_id:'telegram-1'},
      ]);
      if(normalized.startsWith('SELECT user_id,group_id,max_transaction_value_wei'))return result();
      if(normalized.startsWith('SELECT COUNT(*)::INTEGER AS count FROM wallets WHERE user_id=$1'))return result([{count:2}]);
      if(normalized.includes('FROM wallets source JOIN wallets target')&&normalized.includes('LOWER(target.address)'))return result([{count:1}]);
      if(normalized.startsWith('WITH source_labels AS'))return result([{count:0}]);
      if(normalized.startsWith('SELECT COUNT(*)::INTEGER AS count FROM'))return result([{count:0}]);
      if(normalized.startsWith('WITH graph_rows AS'))return result(ownershipRows);
      throw new Error(`Unexpected query: ${normalized}`);
    },
    release(){released=true;},
  };
  return {queries,released:()=>released,repository:createPostgresIdentityRepository({connect:async()=>client})};
}

test('account merge preview uses a repeatable read-only snapshot and never mutates either account',async()=>{
  const {queries,released,repository}=previewFixture();
  const plan=await repository.previewAccountMerge({
    sourcePlatform:'discord',sourcePlatformUserId:'discord-1',
    targetPlatform:'telegram',targetPlatformUserId:'telegram-1',
  });
  assert.equal(plan.classification,'blocked');
  assert.deepEqual(plan.summary.movable,{rows:2,domains:[{key:'wallets',count:2}]});
  assert.deepEqual(plan.summary.blocking.domains,[{key:'walletAddressCollisions',count:1}]);
  const labelCollisionQuery=queries.find(sql=>sql.includes('source_labels'));
  assert.match(labelCollisionQuery,/FROM mint_tasks WHERE user_id=\$1/);
  assert.match(labelCollisionQuery,/FROM activity WHERE user_id=\$1/);
  assert.match(labelCollisionQuery,/FROM snipers WHERE user_id=\$1/);
  assert.match(labelCollisionQuery,/FROM target_trigger_policies/);
  assert.match(labelCollisionQuery,/JOIN launch_squads squad/);
  assert.match(labelCollisionQuery,/squad\.user_id::TEXT=\$1::TEXT/);
  assert.match(labelCollisionQuery,/squad\.user_id::TEXT=\$2::TEXT/);
  const graphQuery=queries.find(sql=>sql.startsWith('WITH graph_rows AS'));
  assert.match(graphQuery,/transaction_state_transitions/);
  assert.match(graphQuery,/transaction_broadcast_hashes/);
  assert.match(graphQuery,/owned_row\.session_id::TEXT AS row_locator/);
  assert.match(graphQuery,/owned_row\.revoked_at IS NULL THEN 'active' ELSE 'revoked'/);
  assert.match(graphQuery,/mint_task_preflight_checks/);
  assert.match(graphQuery,/sniper_event_transitions/);
  assert.match(graphQuery,/launch_squad_members/);
  assert.match(graphQuery,/JOIN wallets owner ON owner\.id=owned_row\.wallet_id/);
  assert.match(graphQuery,/JOIN social_watch_rules owner ON owner\.rule_id=owned_row\.rule_id/);
  assert.match(graphQuery,/owned_row\.user_id=\$1::UUID OR owned_row\.user_id=\$2::UUID/);
  assert.match(graphQuery,/JSONB_AGG\(JSONB_BUILD_ARRAY\(graph_rows\.row_locator,graph_rows\.row_version\)/);
  assert.match(graphQuery,/ENCODE\(SHA256\(CONVERT_TO\(/);
  assert.doesNotMatch(graphQuery,/encrypted_private_key|security_password_hash|code_hash|token_hash|calldata/);
  assert.equal(plan.planVersion,2);
  assert.equal(queries[0],'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(queries.includes('COMMIT'),true);
  assert.equal(queries.some(sql=>/^(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|LOCK)\b/.test(sql)),false);
  assert.equal(released(),true);
});

test('account merge preview digest changes on same-count tuple drift on either account',async()=>{
  const baseRows=ownershipFingerprints({
    source:{users:{count:1},wallets:{count:1,seed:'source-wallet-v1'}},
    target:{users:{count:1,seed:'target-user-v1'}},
  });
  const request={sourcePlatform:'discord',sourcePlatformUserId:'discord-1',
    targetPlatform:'telegram',targetPlatformUserId:'telegram-1'};
  const original=await previewFixture({graphRows:baseRows}).repository.previewAccountMerge(request);
  const sourceChanged=await previewFixture({graphRows:ownershipFingerprints({
    source:{users:{count:1},wallets:{count:1,seed:'source-wallet-v2'}},
    target:{users:{count:1,seed:'target-user-v1'}},
  })}).repository.previewAccountMerge(request);
  const targetChanged=await previewFixture({graphRows:ownershipFingerprints({
    source:{users:{count:1},wallets:{count:1,seed:'source-wallet-v1'}},
    target:{users:{count:1,seed:'target-user-v2'}},
  })}).repository.previewAccountMerge(request);
  assert.notEqual(sourceChanged.snapshotDigest,original.snapshotDigest);
  assert.notEqual(targetChanged.snapshotDigest,original.snapshotDigest);
  assert.deepEqual(sourceChanged.summary.movable,original.summary.movable,
    'row fingerprints, not count changes, must invalidate the reviewed plan');
});

test('account merge preview fails closed before reading identities when ownership migration 072 is absent',async()=>{
  const {queries,released,repository}=previewFixture({schemaCurrent:false});
  await assert.rejects(repository.previewAccountMerge({
    sourcePlatform:'discord',sourcePlatformUserId:'discord-1',
    targetPlatform:'telegram',targetPlatformUserId:'telegram-1',
  }),error=>error.code==='ACCOUNT_MERGE_SCHEMA_OUTDATED');
  assert.equal(queries.includes('ROLLBACK'),true);
  assert.equal(queries.some(sql=>sql.includes('FROM linked_accounts')),false);
  assert.equal(released(),true);
});

test('account merge preview rejects an incomplete or duplicated database fingerprint inventory',async()=>{
  const request={sourcePlatform:'discord',sourcePlatformUserId:'discord-1',
    targetPlatform:'telegram',targetPlatformUserId:'telegram-1'};
  const complete=ownershipFingerprints();
  await assert.rejects(
    previewFixture({graphRows:complete.slice(1)}).repository.previewAccountMerge(request),
    /incomplete ownership inventory/,
  );
  await assert.rejects(
    previewFixture({graphRows:[...complete,complete[0]]}).repository.previewAccountMerge(request),
    /invalid ownership fingerprint/,
  );
});

const EXECUTOR_SOURCE_USER_ID='11111111-1111-4111-8111-111111111111';
const EXECUTOR_TARGET_USER_ID='22222222-2222-4222-8222-222222222222';
const EXECUTOR_EVENT_ID='33333333-3333-4333-8333-333333333333';

const EXECUTOR_DOMAIN_BY_OWNER={
  'wallets.user_id':'wallets',
  'mint_tasks.user_id':'mintTasks',
  'activity.user_id':'activity',
  'pnl_records.user_id':'pnlRecords',
  'snipers.user_id':'snipers',
  'sniper_seen_transactions.user_id':'sniperEvents',
  'transaction_policies.user_id':'transactionPolicies',
  'transaction_intents.user_id':'transactionIntents',
  'mint_presets.user_id':'mintPresets',
  'social_watch_rules.user_id':'socialWatchRules',
  'social_trigger_events.user_id':'socialTriggerEvents',
  'social_adapter_usage.user_id':'socialAdapterUsage',
  'target_trigger_policies.user_id':'targetTriggerPolicies',
  'trigger_execution_requests.user_id':'triggerExecutionRequests',
  'trigger_execution_audit.user_id':'triggerExecutionAudit',
  'bot_security_audit.user_id':'botSecurityAudit',
  'live_acceptance_runs.operator_user_id':'liveAcceptanceRuns',
  'opensea_wallet_eligibility_authorizations.user_id':'openSeaEligibilityAuthorizations',
  'group_retention_events.user_id':'groupRetentionEvents',
  'seat_groups.created_by':'seatGroupsCreated',
  'mode_presets.updated_by':'modePresetsUpdated',
  'user_governance.updated_by':'governanceRowsUpdated',
  'users.status_changed_by':'userStatusesUpdated',
};

function accountRows(){
  return [
    {user_id:EXECUTOR_SOURCE_USER_ID,created_at:new Date('2026-01-01T00:00:00Z'),
      is_owner:false,is_root_owner:false,account_status:'active',status_reason:null,
      status_changed_at:null,suspended_until:null,subscription_active:false,
      good_standing_override:false,dashboard_theme:'ghost-mint',default_chain:null,
      low_balance_threshold_native:'0.01',sniper_observation_default:'confirmed',
      display_currency:'USD',time_format:'24h',username:null,security_password_hash:null,
      display_name:null,bot_gate_level:'off',bot_gate_skip_mint:false},
    {user_id:EXECUTOR_TARGET_USER_ID,created_at:new Date('2025-01-01T00:00:00Z'),
      is_owner:true,is_root_owner:true,account_status:'active',status_reason:null,
      status_changed_at:null,suspended_until:null,subscription_active:false,
      good_standing_override:false,dashboard_theme:'ghost-mint',default_chain:null,
      low_balance_threshold_native:'0.01',sniper_observation_default:'confirmed',
      display_currency:'USD',time_format:'24h',username:null,security_password_hash:null,
      display_name:null,bot_gate_level:'off',bot_gate_skip_mint:false},
  ];
}

function executorFixture({rootOwner=true,movableCounts={wallets:1,activity:2},activeSnipers=0,
  actualMoveCounts=movableCounts,
  actualRevokedCounts={dashboardSessions:2,accountLinkCodes:2,targetBypassChallenges:1}}={}){
  const queries=[];
  const clients=[];
  let sourceDeleted=false;
  let serializationFailuresRemaining=0;
  let existingEvent=null;
  const sourceGraph={users:{count:1},linkedAccounts:{count:1}};
  for(const [domain,count] of Object.entries(movableCounts))sourceGraph[domain]={count};
  if(activeSnipers&&!sourceGraph.snipers)sourceGraph.snipers={count:activeSnipers};
  const preGraph=ownershipFingerprints({source:sourceGraph,
    target:{users:{count:1},linkedAccounts:{count:1}}});
  const postGraph=ownershipFingerprints({source:{},target:{users:{count:1},linkedAccounts:{count:2},
    ...Object.fromEntries(Object.entries(movableCounts).map(([key,count])=>[key,{count}]))}});
  const linkedBefore=[
    {user_id:EXECUTOR_SOURCE_USER_ID,platform:'discord',platform_user_id:'discord-source',
      linked_at:new Date('2026-01-01T00:00:00Z')},
    {user_id:EXECUTOR_TARGET_USER_ID,platform:'telegram',platform_user_id:'telegram-target',
      linked_at:new Date('2025-01-01T00:00:00Z')},
  ];
  const countForOwner=(table,column)=>Number(movableCounts[EXECUTOR_DOMAIN_BY_OWNER[`${table}.${column}`]]||0);

  function makeClient(){
    let released=false;
    const client={
      async query(sql,params=[]){
        const normalized=String(sql).replace(/\s+/g,' ').trim();
        queries.push({sql:normalized,params,client:clients.length});
        if(normalized==='BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
          || normalized==='BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE'
          || normalized==='COMMIT'||normalized==='ROLLBACK')return result();
        if(normalized==='SELECT user_id,is_root_owner FROM users WHERE user_id=$1'){
          return result([{user_id:EXECUTOR_TARGET_USER_ID,is_root_owner:rootOwner}]);
        }
        if(normalized.startsWith('SELECT event_id,status,outcome_code,actor_user_id')){
          return existingEvent?result([existingEvent]):result();
        }
        if(normalized.startsWith('SELECT platform,platform_user_id,user_id FROM linked_accounts')){
          if(normalized.endsWith('FOR UPDATE')&&serializationFailuresRemaining>0){
            serializationFailuresRemaining-=1;
            const error=new Error('serialization retry');error.code='40001';throw error;
          }
          return result(linkedBefore.map(({platform,platform_user_id,user_id})=>({platform,platform_user_id,user_id})));
        }
        if(normalized.startsWith('SELECT user_id,is_root_owner FROM users WHERE user_id=ANY')){
          return result([
            {user_id:EXECUTOR_SOURCE_USER_ID,is_root_owner:false},
            {user_id:EXECUTOR_TARGET_USER_ID,is_root_owner:rootOwner},
          ]);
        }
        if(normalized.startsWith('SELECT owned_row.ctid FROM '))return result();
        if(normalized.startsWith('SELECT filename FROM schema_migrations')){
          return result([{filename:'072_account_merge_ownership_fks.sql'}]);
        }
        if(normalized.startsWith('SELECT user_id,created_at,is_owner'))return result(accountRows());
        if(normalized.startsWith('SELECT user_id,platform,platform_user_id FROM linked_accounts')){
          return result(linkedBefore.map(({user_id,platform,platform_user_id})=>({user_id,platform,platform_user_id})));
        }
        if(normalized.startsWith('SELECT user_id,group_id,max_transaction_value_wei'))return result();
        if(normalized.startsWith('SELECT COUNT(*)::INTEGER AS count FROM snipers')
          && normalized.includes('active=TRUE'))return result([{count:activeSnipers}]);
        if(normalized.startsWith('SELECT COUNT(*)::INTEGER AS count FROM')
          && (normalized.includes("status IN ('scheduled','claimed','retry','paused')")
            || normalized.includes("state IN ('submitted','pending','unknown')")
            || normalized.includes("state IN ('detected','submitted')")
            || normalized.includes('enabled=TRUE')
            || normalized.includes("status IN ('pending','executing')")
            || normalized.includes("status IN ('staged','armed','firing')")
            || normalized.includes("state='claimed'")))return result([{count:0}]);
        if(normalized.startsWith('SELECT COUNT(*)::INTEGER AS count FROM dashboard_sessions')
          || normalized.startsWith('SELECT COUNT(*)::INTEGER AS count FROM account_link_codes')
          || normalized.startsWith('SELECT COUNT(*)::INTEGER AS count FROM target_bypass_challenges')){
          if(normalized.includes('=ANY($1::UUID[])')){
            if(normalized.includes('dashboard_sessions'))return result([{count:2}]);
            if(normalized.includes('account_link_codes'))return result([{count:2}]);
            return result([{count:1}]);
          }
          return result([{count:1}]);
        }
        if(normalized==='SELECT COUNT(*)::INTEGER AS count FROM launch_squads WHERE user_id::TEXT=$1'){
          return result([{count:Number(movableCounts.launchSquads||0)}]);
        }
        if(normalized.startsWith('WITH source_labels AS'))return result([{count:0}]);
        if(normalized.startsWith('SELECT COUNT(*)::INTEGER AS count FROM')){
          const direct=normalized.match(/^SELECT COUNT\(\*\)::INTEGER AS count FROM ([a-z_]+) WHERE ([a-z_]+)=\$1$/);
          if(direct)return result([{count:countForOwner(direct[1],direct[2])}]);
          return result([{count:0}]);
        }
        if(normalized.startsWith('WITH graph_rows AS'))return result(sourceDeleted?postGraph:preGraph);
        if(normalized.startsWith('SELECT user_id,platform,platform_user_id,linked_at FROM linked_accounts')){
          if(normalized.includes('WHERE user_id=$1')){
            return result(linkedBefore.map(row=>({...row,user_id:EXECUTOR_TARGET_USER_ID})));
          }
          return result(linkedBefore);
        }
        if(normalized==='SELECT clock_timestamp() AS started_at'){
          return result([{started_at:new Date('2026-10-10T10:00:00Z')}]);
        }
        const moved=normalized.match(/^UPDATE ([a-z_]+) SET ([a-z_]+)=\$2 WHERE \2=\$1$/);
        if(moved){
          const domain=EXECUTOR_DOMAIN_BY_OWNER[`${moved[1]}.${moved[2]}`];
          const count=moved[1]==='linked_accounts'?1:Number(actualMoveCounts[domain]||0);
          return {rowCount:count,rows:[]};
        }
        if(normalized.startsWith('UPDATE dashboard_sessions SET revoked_at=NOW()')){
          return {rowCount:actualRevokedCounts.dashboardSessions,rows:[]};
        }
        if(normalized.startsWith('DELETE FROM account_link_codes')){
          return {rowCount:actualRevokedCounts.accountLinkCodes,rows:[]};
        }
        if(normalized.startsWith('DELETE FROM target_bypass_challenges')){
          return {rowCount:actualRevokedCounts.targetBypassChallenges,rows:[]};
        }
        if(normalized==='DELETE FROM users WHERE user_id=$1'){
          sourceDeleted=true;return {rowCount:1,rows:[]};
        }
        if(normalized.startsWith('INSERT INTO account_merge_events')){
          const row={event_id:EXECUTOR_EVENT_ID,status:'committed',outcome_code:'MERGE_COMMITTED',
            actor_user_id:params[1],source_user_id:params[2],target_user_id:params[3],
            plan_version:params[8],plan_digest:params[9],resolution_map:JSON.parse(params[10]),
            moved_counts:JSON.parse(params[11]),revoked_counts:JSON.parse(params[12]),
            finished_at:new Date('2026-10-10T10:00:01Z')};
          existingEvent=row;
          return result([row]);
        }
        throw new Error(`Unexpected query: ${normalized}`);
      },
      release(){released=true;},
      released:()=>released,
    };
    clients.push(client);
    return client;
  }
  const repository=createPostgresIdentityRepository({connect:async()=>makeClient()});
  return {
    queries,clients,repository,
    armSerializationFailure(count=1){serializationFailuresRemaining=count;},
    setExistingEvent(value){existingEvent=value;},
  };
}

function executionInput(plan){
  return {
    actorUserId:EXECUTOR_TARGET_USER_ID,
    sourcePlatform:'discord',sourcePlatformUserId:'discord-source',
    targetPlatform:'telegram',targetPlatformUserId:'telegram-target',
    expectedSourceUserId:EXECUTOR_SOURCE_USER_ID,
    expectedTargetUserId:EXECUTOR_TARGET_USER_ID,
    expectedPlanVersion:plan.planVersion,
    expectedSnapshotDigest:plan.snapshotDigest,
    resolutionMap:{},idempotencyKey:'account-merge:test-key',
  };
}

async function reviewedExecution(fixture){
  const plan=await fixture.repository.previewAccountMerge({
    sourcePlatform:'discord',sourcePlatformUserId:'discord-source',
    targetPlatform:'telegram',targetPlatformUserId:'telegram-target',
  });
  return {plan,input:executionInput(plan)};
}

test('ready-plan executor moves reviewed rows, revokes both accounts, records evidence, and commits',async()=>{
  const fixture=executorFixture();
  const {plan,input}=await reviewedExecution(fixture);
  assert.equal(plan.classification,'ready');
  const receipt=await fixture.repository.executeAccountMerge(input);
  assert.deepEqual(receipt.movedCounts,{linkedAccounts:1,wallets:1,activity:2});
  assert.deepEqual(receipt.revokedCounts,{dashboardSessions:2,accountLinkCodes:2,targetBypassChallenges:1});
  assert.equal(receipt.eventId,EXECUTOR_EVENT_ID);
  assert.equal(receipt.replayed,false);
  const execution=fixture.queries.map(entry=>entry.sql);
  const begin=execution.lastIndexOf('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  const firstMove=execution.findIndex((sql,index)=>index>begin&&sql.startsWith('UPDATE linked_accounts SET user_id=$2'));
  const sourceDelete=execution.findIndex((sql,index)=>index>begin&&sql==='DELETE FROM users WHERE user_id=$1');
  const eventInsert=execution.findIndex((sql,index)=>index>begin&&sql.startsWith('INSERT INTO account_merge_events'));
  const commit=execution.findIndex((sql,index)=>index>eventInsert&&sql==='COMMIT');
  assert.ok(begin>=0&&firstMove>begin&&sourceDelete>firstMove&&eventInsert>sourceDelete&&commit>eventInsert);
  assert.equal(fixture.clients.every(client=>client.released()),true);
});

test('executor rejects a stale digest before any ownership mutation',async()=>{
  const fixture=executorFixture();
  const {input}=await reviewedExecution(fixture);
  input.expectedSnapshotDigest=`sha256:${'0'.repeat(64)}`;
  await assert.rejects(fixture.repository.executeAccountMerge(input),error=>{
    assert.equal(error.code,'ACCOUNT_MERGE_STALE');
    assert.equal(error.details.freshPlan.classification,'ready');
    return true;
  });
  const execution=fixture.queries.map(entry=>entry.sql);
  assert.equal(execution.some(sql=>sql.startsWith('UPDATE linked_accounts SET user_id=$2')),false);
  assert.equal(execution.includes('DELETE FROM users WHERE user_id=$1'),false);
  assert.equal(execution.some(sql=>sql.startsWith('INSERT INTO account_merge_events')),false);
  assert.equal(execution.includes('ROLLBACK'),true);
});

test('executor rolls back if a reviewed ownership count changes before its move',async()=>{
  const fixture=executorFixture({actualMoveCounts:{wallets:0,activity:2}});
  const {input}=await reviewedExecution(fixture);
  await assert.rejects(fixture.repository.executeAccountMerge(input),error=>{
    assert.equal(error.code,'ACCOUNT_MERGE_POSTCONDITION_FAILED');
    assert.deepEqual(error.details,{domain:'wallets',expected:1,actual:0});
    return true;
  });
  const execution=fixture.queries.map(entry=>entry.sql);
  const begin=execution.lastIndexOf('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  const attempt=execution.slice(begin);
  assert.equal(attempt.includes('ROLLBACK'),true);
  assert.equal(attempt.includes('COMMIT'),false);
  assert.equal(attempt.includes('DELETE FROM users WHERE user_id=$1'),false);
  assert.equal(attempt.some(sql=>sql.startsWith('INSERT INTO account_merge_events')),false);
});

test('executor rolls back if authentication revocation counts drift after review',async()=>{
  const fixture=executorFixture({actualRevokedCounts:{
    dashboardSessions:1,accountLinkCodes:2,targetBypassChallenges:1,
  }});
  const {input}=await reviewedExecution(fixture);
  await assert.rejects(fixture.repository.executeAccountMerge(input),error=>{
    assert.equal(error.code,'ACCOUNT_MERGE_POSTCONDITION_FAILED');
    assert.deepEqual(error.details,{domain:'dashboardSessions',expected:2,actual:1});
    return true;
  });
  const execution=fixture.queries.map(entry=>entry.sql);
  const begin=execution.lastIndexOf('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  const attempt=execution.slice(begin);
  assert.equal(attempt.includes('ROLLBACK'),true);
  assert.equal(attempt.includes('COMMIT'),false);
  assert.equal(attempt.includes('DELETE FROM users WHERE user_id=$1'),false);
  assert.equal(attempt.some(sql=>sql.startsWith('INSERT INTO account_merge_events')),false);
});

test('executor refuses a current blocked plan without mutating either account',async()=>{
  const fixture=executorFixture({activeSnipers:1});
  const {plan,input}=await reviewedExecution(fixture);
  assert.equal(plan.classification,'blocked');
  await assert.rejects(fixture.repository.executeAccountMerge(input),
    error=>error.code==='ACCOUNT_MERGE_NOT_READY'&&error.details.freshPlan.classification==='blocked');
  const execution=fixture.queries.map(entry=>entry.sql);
  assert.equal(execution.some(sql=>sql.startsWith('UPDATE linked_accounts SET user_id=$2')),false);
  assert.equal(execution.includes('DELETE FROM users WHERE user_id=$1'),false);
  assert.equal(execution.some(sql=>sql.startsWith('INSERT INTO account_merge_events')),false);
});

test('executor checks root ownership before reading merge evidence or locking account graphs',async()=>{
  const fixture=executorFixture({rootOwner:false});
  const input={...executionInput({planVersion:2,snapshotDigest:`sha256:${'1'.repeat(64)}`})};
  await assert.rejects(fixture.repository.executeAccountMerge(input),
    error=>error.code==='ACCOUNT_MERGE_ROOT_REQUIRED');
  const execution=fixture.queries.map(entry=>entry.sql);
  assert.equal(execution.some(sql=>sql.includes('FROM account_merge_events')),false);
  assert.equal(execution.some(sql=>sql.startsWith('SELECT owned_row.ctid')),false);
  assert.equal(execution.some(sql=>/^(UPDATE|DELETE|INSERT)\b/.test(sql)),false);
  assert.equal(execution.includes('ROLLBACK'),true);
});

test('executor replays matching immutable evidence without touching account rows',async()=>{
  const fixture=executorFixture();
  const {input}=await reviewedExecution(fixture);
  fixture.setExistingEvent({
    event_id:EXECUTOR_EVENT_ID,status:'committed',outcome_code:'MERGE_COMMITTED',
    actor_user_id:input.actorUserId,source_user_id:input.expectedSourceUserId,
    target_user_id:input.expectedTargetUserId,plan_version:input.expectedPlanVersion,
    plan_digest:input.expectedSnapshotDigest,resolution_map:{},moved_counts:{linkedAccounts:1},
    revoked_counts:{dashboardSessions:2},finished_at:new Date('2026-10-10T10:00:01Z'),
  });
  const receipt=await fixture.repository.executeAccountMerge(input);
  assert.equal(receipt.replayed,true);
  const execution=fixture.queries.map(entry=>entry.sql);
  const begin=execution.lastIndexOf('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  const afterBegin=execution.slice(begin);
  assert.equal(afterBegin.some(sql=>sql.endsWith('FOR UPDATE')),false);
  assert.equal(afterBegin.some(sql=>/^(UPDATE|DELETE|INSERT)\b/.test(sql)),false);
  assert.equal(afterBegin.includes('COMMIT'),true);
});

test('executor retries a serialization failure with a fresh transaction and client',async()=>{
  const fixture=executorFixture();
  const {input}=await reviewedExecution(fixture);
  fixture.armSerializationFailure();
  const receipt=await fixture.repository.executeAccountMerge(input);
  assert.equal(receipt.status,'committed');
  const execution=fixture.queries.map(entry=>entry.sql);
  assert.equal(execution.filter(sql=>sql==='BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE').length,2);
  assert.equal(execution.filter(sql=>sql==='ROLLBACK').length,1);
  assert.equal(execution.filter(sql=>sql==='COMMIT').length,2,
    'the managed preview and the successful retry each commit once');
  assert.equal(fixture.clients.length,3,
    'one preview client plus one released client for each execution attempt');
  assert.equal(fixture.clients.every(client=>client.released()),true);
});

test('executor returns a stable app error after exhausting serialization retries',async()=>{
  const fixture=executorFixture();
  const {input}=await reviewedExecution(fixture);
  fixture.armSerializationFailure(3);
  await assert.rejects(fixture.repository.executeAccountMerge(input),error=>{
    assert.equal(error.code,'ACCOUNT_MERGE_RETRY_EXHAUSTED');
    assert.match(error.message,/Review them and try again/);
    return true;
  });
  const execution=fixture.queries.map(entry=>entry.sql);
  assert.equal(execution.filter(sql=>sql==='BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE').length,3);
  assert.equal(execution.filter(sql=>sql==='ROLLBACK').length,3);
  assert.equal(execution.some(sql=>sql.startsWith('UPDATE linked_accounts SET user_id=$2')),false);
  assert.equal(fixture.clients.every(client=>client.released()),true);
});

function mergeFixture({sameAccount=false,targetPlatformConflict=false}={}){
  const queries=[];
  let released=false;
  const sourceUserId=sameAccount?'target-user':'source-user';
  const client={
    async query(sql){
      const normalized=String(sql).replace(/\s+/g,' ').trim();
      queries.push(normalized);
      if(['BEGIN','COMMIT','ROLLBACK','LOCK TABLE launch_squads IN SHARE MODE'].includes(normalized))return result();
      if(normalized.startsWith('SELECT platform,platform_user_id,user_id FROM linked_accounts'))return result([
        {platform:'discord',platform_user_id:'discord-1',user_id:sourceUserId},
        {platform:'telegram',platform_user_id:'telegram-1',user_id:'target-user'},
      ]);
      if(normalized.startsWith('SELECT user_id FROM users WHERE user_id=ANY'))return result([
        {user_id:'source-user'},{user_id:'target-user'},
      ]);
      if(normalized.startsWith('SELECT platform_user_id FROM linked_accounts')){
        return targetPlatformConflict?result([{platform_user_id:'discord-other'}]):result();
      }
      if(normalized.startsWith('SELECT group_id,max_transaction_value_wei'))return result();
      if(normalized.startsWith('SELECT is_owner,is_root_owner'))return result([{
        is_owner:false,is_root_owner:false,account_status:'active',status_reason:null,suspended_until:null,
        subscription_active:false,good_standing_override:false,dashboard_theme:'ghost-mint',default_chain:null,
        low_balance_threshold_native:'0.01',sniper_observation_default:'confirmed',display_currency:'USD',
        time_format:'24h',username:null,security_password_hash:null,display_name:null,bot_gate_level:'off',
        bot_gate_skip_mint:false,
      }]);
      if(normalized==='SELECT platform,platform_user_id FROM linked_accounts WHERE user_id=$1'){
        return result([{platform:'discord',platform_user_id:'discord-1'}]);
      }
      if(normalized.startsWith('SELECT COUNT(*)::INTEGER AS count FROM'))return result([{count:0}]);
      if(normalized.startsWith('UPDATE linked_accounts SET user_id='))return result();
      if(normalized.startsWith('DELETE FROM account_link_codes'))return result();
      if(normalized.startsWith('DELETE FROM users'))return result();
      throw new Error(`Unexpected query: ${normalized}`);
    },
    release(){released=true;},
  };
  return {queries,released:()=>released,repository:createPostgresIdentityRepository({connect:async()=>client})};
}

test('limited account merge locks identities deterministically and protects the legacy squad check',async()=>{
  const {queries,released,repository}=mergeFixture();
  assert.deepEqual(await repository.mergeAccount({
    sourcePlatform:'discord',sourcePlatformUserId:'discord-1',
    targetPlatform:'telegram',targetPlatformUserId:'telegram-1',
  }),{sourceUserId:'source-user',targetUserId:'target-user'});
  assert.equal(queries.filter(value=>value.startsWith('SELECT platform,platform_user_id,user_id FROM linked_accounts')).length,1);
  assert.equal(queries.includes('LOCK TABLE launch_squads IN SHARE MODE'),true);
  assert.ok(queries.indexOf('LOCK TABLE launch_squads IN SHARE MODE')
    < queries.findIndex(value=>value.startsWith('SELECT COUNT(*)::INTEGER AS count FROM launch_squads')));
  assert.equal(queries.includes('COMMIT'),true);
  assert.equal(released(),true);
});

test('repeating a completed account merge returns an idempotent already-unified result',async()=>{
  const {queries,released,repository}=mergeFixture({sameAccount:true});
  assert.deepEqual(await repository.mergeAccount({
    sourcePlatform:'discord',sourcePlatformUserId:'discord-1',
    targetPlatform:'telegram',targetPlatformUserId:'telegram-1',
  }),{sourceUserId:'target-user',targetUserId:'target-user',status:'already_unified'});
  assert.equal(queries.includes('COMMIT'),true);
  assert.equal(queries.some(value=>value.startsWith('DELETE FROM users')),false);
  assert.equal(released(),true);
});

test('limited account merge refuses a second identity for the same platform on the retained account',async()=>{
  const {queries,released,repository}=mergeFixture({targetPlatformConflict:true});
  await assert.rejects(repository.mergeAccount({
    sourcePlatform:'discord',sourcePlatformUserId:'discord-1',
    targetPlatform:'telegram',targetPlatformUserId:'telegram-1',
  }),error=>error.code==='TARGET_PLATFORM_CONFLICT');
  assert.equal(queries.includes('ROLLBACK'),true);
  assert.equal(queries.some(value=>value.startsWith('UPDATE linked_accounts SET user_id=')),false);
  assert.equal(released(),true);
});
