'use strict';

const path=require('node:path');
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {CONFIG}=require('../src/config');
const {runMigrations}=require('../src/db/migrate');
const {createDatabasePool}=require('../src/db/pool');
const {createPostgresStorage}=require('../src/storage/postgresStorage');
const {createSchedulerRepository}=require('../src/scheduler/schedulerRepository');
const {createScheduledPreflightRepository}=require('../src/scheduler/scheduledPreflightRepository');
const {createPostgresIdentityRepository}=require('../src/identity/postgresIdentityRepository');
const {createIdentityService}=require('../src/identity/identityService');
const {createKeyEncryption}=require('../src/security/keyEncryption');

const integrationTest=CONFIG.databaseUrl&&CONFIG.databaseUrlUnpooled?test:test.skip;

integrationTest('durable schedule checks claim once, recover an expired lease, and re-arm by generation',
  {timeout:120_000},async()=>{
    await runMigrations({connectionString:CONFIG.databaseUrlUnpooled,
      migrationsDirectory:path.join(CONFIG.projectRoot,'migrations')});
    const pool=createDatabasePool({connectionString:CONFIG.databaseUrl,max:4});
    const storage=createPostgresStorage(pool);
    const scheduler=createSchedulerRepository(pool);
    const left=createScheduledPreflightRepository(pool);
    const right=createScheduledPreflightRepository(pool);
    const identity=createIdentityService(createPostgresIdentityRepository(pool));
    const userId=await identity.resolveOrCreate('telegram',`preflight-${process.pid}-${Date.now()}`);
    const walletLabel=`preflight-${Date.now()}`;
    const walletAddress='0x0000000000000000000000000000000000000062';
    const contract='0x0000000000000000000000000000000000000063';
    const crypto=createKeyEncryption({activeVersion:CONFIG.encryptionKeyVersion,keys:CONFIG.encryptionKeys});
    await storage.addWallet({userId,label:walletLabel,address:walletAddress,chain:'ethereum',
      keyEnvelope:crypto.encrypt(`0x${'62'.repeat(32)}`),minted:0,addedAt:Date.now()});
    const firstTarget=Date.now()+4*60*1000;
    const task={userId,id:randomUUID(),name:'preflight integration',walletLabel,walletAddress,
      contract,fn:'mint',qty:1,price:0,gas:null,chain:'ethereum',mintTime:firstTarget,
      status:'scheduled',createdAt:Date.now(),nextAttemptAt:firstTarget,maxAttempts:3,
      stageUuid:'public-preflight',stageLabel:'Public',stageType:'public_sale',
      reservationStageKey:'uuid:public-preflight',eligibilityMode:'specific_stage'};
    try{
      assert.equal((await storage.createReservedTask(task)).created,true);
      const now=Date.now();
      const [a,b]=await Promise.all([
        left.claimDue({workerId:'left',now,leaseMs:60_000,limit:5,userId,taskId:task.id}),
        right.claimDue({workerId:'right',now,leaseMs:60_000,limit:5,userId,taskId:task.id}),
      ]);
      assert.equal(a.length+b.length,1,'only one worker may claim the due five-minute check');
      const first=(a[0]||b[0]);
      assert.equal(first.check.checkpoint,'five_minute');
      assert.equal((await left.complete(first,{result:'ready',reason:'ready',mintValueWei:0n,
        estimatedGasWei:1n,totalDebitWei:1n,balanceWei:2n,shortfallWei:0n})).completed,true);
      const [notificationA,notificationB]=await Promise.all([
        left.claimNotifications({workerId:'notify-left',now:Date.now(),leaseMs:60_000,limit:5,userId,taskId:task.id}),
        right.claimNotifications({workerId:'notify-right',now:Date.now(),leaseMs:60_000,limit:5,userId,taskId:task.id}),
      ]);
      assert.equal(notificationA.length+notificationB.length,1,
        'only one worker may claim a committed checkpoint notification');
      const notificationClaim=notificationA[0]||notificationB[0];
      await pool.query(`UPDATE mint_task_preflight_checks
        SET notification_lease_expires_at=NOW()-INTERVAL '1 second' WHERE check_id=$1`,
      [notificationClaim.check.checkId]);
      const recoveredNotification=await right.claimNotifications({workerId:'notify-replacement',
        now:Date.now(),leaseMs:60_000,limit:1,userId,taskId:task.id});
      assert.equal(recoveredNotification.length,1);
      const delivered=await right.finishNotification(recoveredNotification[0],{now:Date.now()});
      assert.equal(delivered.notificationState,'delivered');

      const secondTarget=Date.now()+4*60*1000+5_000;
      const moved=await scheduler.moveFireTime(userId,task.id,secondTarget);
      assert.equal(moved.preflightGeneration,2);
      const generations=await pool.query(`SELECT generation,state,checkpoint FROM mint_task_preflight_checks
        WHERE user_id=$1 AND task_id=$2 ORDER BY generation,checkpoint`,[userId,task.id]);
      assert.equal(generations.rows.filter(row=>Number(row.generation)===2).length,2);
      assert.equal(generations.rows.find(row=>Number(row.generation)===1&&row.checkpoint==='thirty_second').state,
        'superseded');

      const crashed=await left.claimDue({workerId:'crashed',now:Date.now(),leaseMs:60_000,limit:1,userId,taskId:task.id});
      assert.equal(crashed.length,1);assert.equal(crashed[0].check.generation,2);
      await pool.query(`UPDATE mint_task_preflight_checks SET lease_expires_at=NOW()-INTERVAL '1 second'
        WHERE check_id=$1`,[crashed[0].check.checkId]);
      const recovered=await right.claimDue({workerId:'replacement',now:Date.now(),leaseMs:60_000,limit:1,userId,taskId:task.id});
      assert.equal(recovered.length,1);assert.equal(recovered[0].check.checkId,crashed[0].check.checkId);
      assert.equal(recovered[0].check.claimedBy,'replacement');
    }finally{
      await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{});
      await storage.close();
    }
  });

integrationTest('schedule changes commit atomically, reject stale work, survive restart, and expire safely',
  {timeout:120_000},async()=>{
    await runMigrations({connectionString:CONFIG.databaseUrlUnpooled,
      migrationsDirectory:path.join(CONFIG.projectRoot,'migrations')});
    const pool=createDatabasePool({connectionString:CONFIG.databaseUrl,max:6});
    const storage=createPostgresStorage(pool);
    const scheduler=createSchedulerRepository(pool);
    const left=createScheduledPreflightRepository(pool);
    const right=createScheduledPreflightRepository(pool);
    const identity=createIdentityService(createPostgresIdentityRepository(pool));
    const userId=await identity.resolveOrCreate('telegram',`schedule-change-${process.pid}-${Date.now()}`);
    const walletLabel=`schedule-change-${Date.now()}`;
    const walletAddress='0x0000000000000000000000000000000000000065';
    const crypto=createKeyEncryption({activeVersion:CONFIG.encryptionKeyVersion,keys:CONFIG.encryptionKeys});
    await storage.addWallet({userId,label:walletLabel,address:walletAddress,chain:'ethereum',
      keyEnvelope:crypto.encrypt(`0x${'65'.repeat(32)}`),minted:0,addedAt:Date.now()});
    let contractSequence=0;
    async function createTask(overrides={}){
      contractSequence+=1;
      const opening=overrides.opening??Date.now()+4*60*1000;
      const id=randomUUID();
      const contract=`0x${contractSequence.toString(16).padStart(40,'0')}`;
      const task={userId,id,name:`change-${contractSequence}`,walletLabel,walletAddress,
        contract,fn:'mint',qty:1,price:0,gas:null,chain:'ethereum',mintTime:opening,
        status:'scheduled',createdAt:Date.now(),nextAttemptAt:opening,maxAttempts:3,
        stageUuid:`public-change-${contractSequence}`,stageLabel:'Public',stageType:'public_sale',
        reservationStageKey:`uuid:public-change-${contractSequence}`,
        eligibilityMode:overrides.eligibilityMode??'specific_stage',
        eligibilityDeadline:Object.prototype.hasOwnProperty.call(overrides,'eligibilityDeadline')
          ?overrides.eligibilityDeadline:opening+60*60*1000,
        originalOpeningAt:opening,acceptedOpeningAt:opening,lastObservedOpeningAt:opening,
        timeChangePolicy:overrides.timeChangePolicy??'approval',
        maxOpeningDelayMs:overrides.maxOpeningDelayMs??null,
        acceptedPriceWeiPerItem:overrides.acceptedPriceWeiPerItem??'1',
        lastObservedPriceWeiPerItem:overrides.acceptedPriceWeiPerItem??'1',
        priceChangePolicy:overrides.priceChangePolicy??'approval',
        maxPriceWeiPerItem:overrides.maxPriceWeiPerItem??null,
        acceptedConfigFingerprint:'cfg-a',lastObservedConfigFingerprint:'cfg-a',
        acceptedConfigSummary:{method:'mint'},lastObservedConfigSummary:{method:'mint'}};
      assert.equal((await storage.createReservedTask(task)).created,true);
      return task;
    }
    const ready={result:'ready',reason:'ready',mintValueWei:0n,estimatedGasWei:1n,
      totalDebitWei:1n,balanceWei:2n,shortfallWei:0n};
    try{
      const auto=await createTask({timeChangePolicy:'auto_within_limit',maxOpeningDelayMs:10*60*1000,
        priceChangePolicy:'allow_up_to_cap',maxPriceWeiPerItem:'10'});
      // Force both checkpoints due while preserving their real target. Completing one must move the
      // generation atomically, and the other already-claimed checkpoint must lose as stale work.
      await pool.query(`UPDATE mint_task_preflight_checks SET due_at=NOW()-INTERVAL '1 second'
        WHERE user_id=$1 AND task_id=$2`,[userId,auto.id]);
      const claimed=await left.claimDue({workerId:'change-left',now:Date.now(),leaseMs:60_000,
        limit:5,userId,taskId:auto.id});
      assert.equal(claimed.length,2);
      const movedOpening=auto.mintTime+5*60*1000;
      const first=await left.complete(claimed[0],{...ready,scheduleObservation:{
        openingAt:movedOpening,priceWeiPerItem:'2',configFingerprint:'cfg-a',source:'integration'}});
      assert.equal(first.completed,true);
      assert.equal(first.scheduleChange.action,'auto_rescheduled');
      assert.equal(first.task.status,'retry');
      assert.equal(first.task.preflightGeneration,2);
      assert.equal(first.task.acceptedOpeningAt,movedOpening);
      assert.equal(first.task.acceptedPriceWeiPerItem,'2');
      const stale=await right.complete(claimed[1],{...ready,scheduleObservation:{
        openingAt:movedOpening,priceWeiPerItem:'2',configFingerprint:'cfg-a',source:'stale'}});
      assert.equal(stale.completed,false,'a claim from the previous generation must not commit');
      const autoRows=await pool.query(`SELECT generation,state,checkpoint FROM mint_task_preflight_checks
        WHERE user_id=$1 AND task_id=$2 ORDER BY generation,checkpoint`,[userId,auto.id]);
      assert.equal(autoRows.rows.filter(row=>Number(row.generation)===2).length,2);
      assert.equal(autoRows.rows.filter(row=>Number(row.generation)===1&&row.state==='superseded').length,1);

      const reviewOpening=Date.now()+4*60*1000;
      const review=await createTask({opening:reviewOpening,eligibilityDeadline:reviewOpening+3*60*60*1000,
        timeChangePolicy:'auto_within_limit',maxOpeningDelayMs:60_000,
        priceChangePolicy:'allow_up_to_cap',maxPriceWeiPerItem:'5'});
      const reviewClaim=(await left.claimDue({workerId:'review-left',now:Date.now(),leaseMs:60_000,
        limit:1,userId,taskId:review.id}))[0];
      const reviewResult=await left.complete(reviewClaim,{...ready,scheduleObservation:{
        openingAt:review.mintTime+2*60*60*1000,priceWeiPerItem:'20',
        configFingerprint:'cfg-b',configSummary:{method:'mintPublic'},source:'integration'}});
      assert.equal(reviewResult.scheduleChange.action,'awaiting_approval');
      assert.equal(reviewResult.task.status,'paused');
      assert.equal(reviewResult.task.changeState,'awaiting_approval');
      assert.deepEqual(new Set(reviewResult.task.pendingChange.kinds),new Set(['opening','price','configuration']));
      const event=await pool.query(`SELECT * FROM mint_task_change_events
        WHERE user_id=$1 AND task_id=$2`,[userId,review.id]);
      assert.equal(event.rowCount,1);
      assert.equal(event.rows[0].action,'awaiting_approval');

      // A fresh repository instance must be able to deliver the already-committed notification.
      const restarted=createScheduledPreflightRepository(pool);
      const outbox=await restarted.claimNotifications({workerId:'after-restart',now:Date.now(),
        leaseMs:60_000,limit:1,userId,taskId:review.id});
      assert.equal(outbox.length,1);
      assert.equal(outbox[0].check.scheduleChangeAction,'awaiting_approval');
      assert.equal((await restarted.finishNotification(outbox[0],{now:Date.now()})).notificationState,'delivered');
      await assert.rejects(()=>scheduler.resolveScheduleChange(userId,review.id,{decision:'approve',
        version:reviewResult.task.changeVersion-1,now:Date.now()}),error=>error.code==='SCHEDULE_CHANGE_STALE');

      // Unanswered change reviews expire exactly once, even when two workers sweep together. The
      // terminal state, event resolution and notification outbox are committed in one transaction.
      await pool.query(`UPDATE mint_tasks SET change_review_expires_at=NOW()-INTERVAL '1 second'
        WHERE user_id=$1 AND id=$2`,[userId,review.id]);
      const [expiredLeft,expiredRight]=await Promise.all([
        left.expirePendingReviews({now:Date.now(),limit:10,userId,taskId:review.id}),
        right.expirePendingReviews({now:Date.now(),limit:10,userId,taskId:review.id}),
      ]);
      assert.equal(expiredLeft.length+expiredRight.length,1,'concurrent sweepers may expire a review only once');
      const expiredReview=await scheduler.detailsForUser(userId,review.id);
      assert.equal(expiredReview.status,'failed');
      assert.equal(expiredReview.changeState,'clear');
      assert.equal(expiredReview.pendingChange,null);
      assert.match(expiredReview.lastError,/^REVIEW_EXPIRED:/);
      assert.equal(expiredReview.changeEvents[0].action,'expired');
      assert.ok(expiredReview.changeEvents[0].resolvedAt);
      const expiryRows=await pool.query(`SELECT * FROM mint_task_preflight_checks
        WHERE user_id=$1 AND task_id=$2 AND checkpoint='change_review_expiry'`,[userId,review.id]);
      assert.equal(expiryRows.rowCount,1);
      const [expiryNoticeLeft,expiryNoticeRight]=await Promise.all([
        left.claimNotifications({workerId:'expiry-notice-left',now:Date.now(),leaseMs:60_000,
          limit:1,userId,taskId:review.id}),
        right.claimNotifications({workerId:'expiry-notice-right',now:Date.now(),leaseMs:60_000,
          limit:1,userId,taskId:review.id}),
      ]);
      const expiryNotices=[...expiryNoticeLeft,...expiryNoticeRight];
      assert.equal(expiryNotices.length,1,'the durable expiry notification may be claimed only once');
      assert.equal(expiryNotices[0].check.scheduleChangeAction,'expired');
      assert.equal(expiryNotices[0].check.result,'review_expired');
      await left.finishNotification(expiryNotices[0],{now:Date.now()});
      await assert.rejects(()=>scheduler.resolveScheduleChange(userId,review.id,{decision:'approve',
        version:reviewResult.task.changeVersion,now:Date.now()}),error=>error.code==='SCHEDULE_CHANGE_STALE');

      // Event identity is the monotonic version, not the observation fingerprint. A later cycle may
      // legitimately repeat the same before/after fingerprint and still needs its own audit row.
      await pool.query(`INSERT INTO mint_task_change_events
          (user_id,task_id,change_version,event_fingerprint,kinds,action,
           previous_snapshot,observed_snapshot,reason)
        VALUES ($1,$2,$3,$4,$5,'accepted',$6::JSONB,$7::JSONB,'Repeated cycle')`,
      [userId,review.id,reviewResult.task.changeVersion+1,event.rows[0].event_fingerprint,
        event.rows[0].kinds,JSON.stringify(event.rows[0].previous_snapshot),
        JSON.stringify(event.rows[0].observed_snapshot)]);
      assert.equal((await pool.query(`SELECT COUNT(*)::INTEGER total FROM mint_task_change_events
        WHERE user_id=$1 AND task_id=$2 AND event_fingerprint=$3`,
      [userId,review.id,event.rows[0].event_fingerprint])).rows[0].total,2);

      const expiring=await createTask({eligibilityDeadline:Date.now()+4*60*1000+1_000});
      const expiryClaim=(await left.claimDue({workerId:'expiry-left',now:Date.now(),leaseMs:60_000,
        limit:1,userId,taskId:expiring.id}))[0];
      const expired=await left.complete(expiryClaim,{...ready,scheduleObservation:{
        openingAt:expiring.mintTime+5_000,priceWeiPerItem:'1',configFingerprint:'cfg-a',
        source:'integration'}});
      assert.equal(expired.scheduleChange.action,'expired');
      assert.equal(expired.task.status,'failed');
      assert.match(expired.scheduleChange.reason,/outside this schedule's safety window/i);

      const soldOut=await createTask();
      const soldOutClaim=(await left.claimDue({workerId:'sold-out-left',now:Date.now(),leaseMs:60_000,
        limit:1,userId,taskId:soldOut.id}))[0];
      const soldOutResult=await left.complete(soldOutClaim,{...ready,result:'sold_out',
        reason:'The collection or selected stage is sold out.'});
      assert.equal(soldOutResult.completed,true);
      assert.equal(soldOutResult.failed,true);
      assert.equal(soldOutResult.cancelled,false);
      assert.equal(soldOutResult.task.status,'failed');
      assert.match(soldOutResult.task.lastError,/^SOLD_OUT:/);

      // Direct/non-phase schedules have no eligibility deadline. Their review still gets a
      // bounded 24-hour decision window rather than remaining approvable forever.
      const directReview=await createTask({eligibilityDeadline:null});
      const directClaim=(await left.claimDue({workerId:'direct-review',now:Date.now(),leaseMs:60_000,
        limit:1,userId,taskId:directReview.id}))[0];
      const directResult=await left.complete(directClaim,{...ready,scheduleObservation:{
        openingAt:directReview.mintTime,priceWeiPerItem:'2',configFingerprint:'cfg-a',
        source:'direct-review'}});
      assert.equal(directResult.scheduleChange.action,'awaiting_approval');
      assert.ok(Number.isFinite(directResult.task.changeReviewExpiresAt));
      assert.ok(directResult.task.changeReviewExpiresAt>Date.now()+23*60*60*1000);

      // Approving a price-only review must not pull execution earlier than the time the user chose.
      const futureReview=await createTask({opening:Date.now()+4*60*1000});
      const futureClaim=(await left.claimDue({workerId:'future-review',now:Date.now(),leaseMs:60_000,
        limit:1,userId,taskId:futureReview.id}))[0];
      const futureResult=await left.complete(futureClaim,{...ready,scheduleObservation:{
        openingAt:futureReview.mintTime-10*60*1000,priceWeiPerItem:'2',configFingerprint:'cfg-a',
        source:'future-review'}});
      const approved=await scheduler.resolveScheduleChange(userId,futureReview.id,{decision:'approve',
        version:futureResult.task.changeVersion,now:Date.now()});
      assert.ok(approved.mintTime>=futureReview.mintTime);
      assert.ok(approved.nextAttemptAt>=futureReview.mintTime);

      // An earliest-eligible move must persist the new stage/reservation BEFORE its opening/price
      // policy is evaluated. Otherwise an auto decision or manual pause can return early with the
      // task still reserving the old allowlist stage even though a public-stage call will run.
      async function moveToPublicThenEvaluate(overrides={}){
        const task=await createTask({eligibilityMode:'earliest_eligible',
          timeChangePolicy:overrides.timeChangePolicy,
          maxOpeningDelayMs:overrides.maxOpeningDelayMs});
        const oldStageUuid=task.stageUuid;
        const opening=task.mintTime+10*60*1000;
        const claimed=await scheduler.claimSpecific({workerId:`stage-move-${oldStageUuid}`,
          userId,taskId:task.id,now:task.mintTime+1,leaseMs:60_000});
        const moved=await scheduler.deferForPhase(claimed,{retryAt:opening,mintTime:opening,
          deadline:task.eligibilityDeadline,stageStartAt:opening,
          stageUuid:`public-next-${oldStageUuid}`,stageLabel:'Public next',stageType:'public_sale',
          reason:'Wallet is not eligible for the earlier stage.',allowanceEvidence:{
            allowanceScope:'unknown',allowanceSource:'integration-stage-advance',
            allowanceVerifiedAt:Date.now(),allowanceStageStartAt:opening,
          }});
        assert.notEqual(moved.stageUuid,oldStageUuid);
        assert.equal(moved.stageUuid,`public-next-${oldStageUuid}`);
        assert.equal(moved.reservationStageKey,`uuid:public-next-${oldStageUuid}`);
        assert.equal(moved.allowanceSource,'integration-stage-advance');
        await pool.query(`UPDATE mint_task_preflight_checks SET due_at=NOW()-INTERVAL '1 second'
          WHERE user_id=$1 AND task_id=$2 AND generation=$3`,
        [userId,task.id,moved.preflightGeneration]);
        const preflightClaim=(await left.claimDue({workerId:`stage-policy-${oldStageUuid}`,
          now:Date.now(),leaseMs:60_000,limit:1,userId,taskId:task.id}))[0];
        assert.ok(preflightClaim);
        const evaluated=await left.complete(preflightClaim,{...ready,scheduleObservation:{
          openingAt:opening,priceWeiPerItem:'1',configFingerprint:'cfg-a',
          source:'integration-stage-advance'}});
        return {task,moved,evaluated};
      }

      const autoStage=await moveToPublicThenEvaluate({timeChangePolicy:'auto_within_limit',
        maxOpeningDelayMs:20*60*1000});
      assert.equal(autoStage.evaluated.scheduleChange.action,'accepted');
      assert.equal(autoStage.evaluated.task.stageUuid,autoStage.moved.stageUuid);
      assert.equal(autoStage.evaluated.task.reservationStageKey,autoStage.moved.reservationStageKey);

      const manualStage=await moveToPublicThenEvaluate({timeChangePolicy:'approval',
        maxOpeningDelayMs:null});
      assert.equal(manualStage.evaluated.scheduleChange.action,'awaiting_approval');
      assert.equal(manualStage.evaluated.task.status,'paused');
      const manualApproved=await scheduler.resolveScheduleChange(userId,manualStage.task.id,{
        decision:'approve',version:manualStage.evaluated.task.changeVersion,now:Date.now()});
      assert.equal(manualApproved.stageUuid,manualStage.moved.stageUuid);
      assert.equal(manualApproved.reservationStageKey,manualStage.moved.reservationStageKey);
    }finally{
      await pool.query('DELETE FROM users WHERE user_id=$1',[userId]).catch(()=>{});
      await storage.close();
    }
  });
