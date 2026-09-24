const { armTaskPreflightRows } = require('../scheduler/scheduledPreflightRepository');
const { scheduleReservationStageKey } = require('../mint/scheduleStagePlanning');
const { enforceScheduleAllowanceEnvelope } = require('../mint/scheduleAllowance');

function number(value) { return value === null || value === undefined ? null : Number(value); }
function time(value) { return value === null || value === undefined ? null : new Date(value).getTime(); }

function mapWallet(row) {
  return {
    id: Number(row.id), userId: row.user_id, label: row.label, address: row.address, chain: row.chain,
    keyEnvelope: { ciphertext: row.encrypted_private_key, salt: row.encryption_salt,
      nonce: row.encryption_nonce, authTag: row.encryption_auth_tag, keyVersion: row.encryption_key_version },
    minted: row.minted, addedAt: time(row.added_at),
  };
}

function mapTask(row) {
  return {
    id: row.id, userId: row.user_id, name: row.name, walletLabel: row.wallet_label,
    contract: row.contract_address, fn: row.function_name, qty: row.quantity,
    price: number(row.price_eth), gas: number(row.gas_gwei), chain: row.chain ?? null, mintTime: time(row.mint_time),
    status: row.status, createdAt: time(row.created_at), nextAttemptAt: time(row.next_attempt_at),
    attemptCount: row.attempt_count, maxAttempts: row.max_attempts,
    transactionIntentId: row.transaction_intent_id, idempotencyKey: row.idempotency_key,
    viaOpenSea: row.via_opensea, stageType: row.stage_type ?? null,
    stageUuid: row.stage_uuid ?? null, stageLabel: row.stage_label ?? null,
    walletAddress: row.wallet_address ?? null,
    reservationStageKey: row.reservation_stage_key ?? null,
    allowanceScope:row.allowance_scope ?? 'unknown',
    allowanceMaxPerWallet:row.allowance_max_per_wallet === null || row.allowance_max_per_wallet === undefined
      ? null:String(row.allowance_max_per_wallet),
    allowanceMintedSnapshot:row.allowance_minted_snapshot === null || row.allowance_minted_snapshot === undefined
      ? null:String(row.allowance_minted_snapshot),
    allowanceSource:row.allowance_source ?? null,
    allowanceVerifiedAt:time(row.allowance_verified_at),
    allowanceStageStartAt:time(row.allowance_stage_start_at),
    eligibilityMode: row.eligibility_mode ?? 'specific_stage',
    eligibilityDeadline: time(row.eligibility_deadline),
    phaseWaitCount: Number(row.phase_wait_count || 0),
    preflightTargetAt:time(row.preflight_target_at),
    preflightGeneration:Number(row.preflight_generation||1),
    originalOpeningAt:time(row.original_opening_at),acceptedOpeningAt:time(row.accepted_opening_at),
    lastObservedOpeningAt:time(row.last_observed_opening_at),
    timeChangePolicy:row.time_change_policy ?? 'approval',
    maxOpeningDelayMs:row.max_opening_delay_ms === null || row.max_opening_delay_ms === undefined
      ? null:Number(row.max_opening_delay_ms),
    acceptedPriceWeiPerItem:row.accepted_price_wei_per_item === null
      || row.accepted_price_wei_per_item === undefined ? null:String(row.accepted_price_wei_per_item),
    lastObservedPriceWeiPerItem:row.last_observed_price_wei_per_item === null
      || row.last_observed_price_wei_per_item === undefined ? null:String(row.last_observed_price_wei_per_item),
    priceChangePolicy:row.price_change_policy ?? 'approval',
    maxPriceWeiPerItem:row.max_price_wei_per_item === null || row.max_price_wei_per_item === undefined
      ? null:String(row.max_price_wei_per_item),
    acceptedConfigFingerprint:row.accepted_config_fingerprint ?? null,
    lastObservedConfigFingerprint:row.last_observed_config_fingerprint ?? null,
    acceptedConfigSummary:row.accepted_config_summary ?? null,
    lastObservedConfigSummary:row.last_observed_config_summary ?? null,
    changeState:row.change_state ?? 'clear',changeVersion:Number(row.change_version||0),
    pendingChange:row.pending_change ?? null,changeDetectedAt:time(row.change_detected_at),
    changeReviewExpiresAt:time(row.change_review_expires_at),
  };
}

function mapActivity(row) {
  return { id: Number(row.id), userId: row.user_id, status: row.status, title: row.title,
    walletLabel: row.wallet_label, txHash: row.tx_hash, explorer: row.explorer, time: time(row.occurred_at),
    actualNetworkCostWei:row.actual_network_cost_wei===null?null:BigInt(row.actual_network_cost_wei),
    transactionValueWei:row.transaction_value_wei===null||row.transaction_value_wei===undefined
      ?null:BigInt(row.transaction_value_wei),tokenIds:row.transaction_token_ids||null,
    collectionName:row.collection_name||null,
    triggerSource:row.trigger_source || row.transaction_trigger_source || null,
    verificationState:row.verification_state || null,
    address: row.address || row.transaction_address || null, chain: row.transaction_chain || null };
}

function mapPnl(row) {
  return { id: row.id, userId: row.user_id, nm: row.name, cost: number(row.cost),
    sale: number(row.sale), gas: number(row.gas), net: number(row.net), t: time(row.created_at) };
}

function mapSniper(row) {
  return {
    id: row.id, userId: row.user_id, label: row.label, targetAddress: row.target_address,
    chain: row.chain, walletLabel: row.wallet_label, valueMode: row.value_mode,
    fixedValueETH: number(row.fixed_value_eth), maxValueETH: number(row.max_value_eth),
    gasBoostPercent: row.gas_boost_percent, maxGasGwei:number(row.max_gas_gwei),
    dailySpendingCapETH:number(row.daily_spending_cap_eth), cooldownMs:row.cooldown_ms,
    maxAttempts:row.max_attempts, contractAllowlist:row.contract_allowlist || [],
    contractDenylist:row.contract_denylist || [], sourceConfirmations:row.source_confirmations,
    observationMode:row.observation_mode || 'confirmed',
    active: row.active, hits: row.hits,
    fails: row.fails, lastFiredAt: time(row.last_fired_at), createdAt: time(row.created_at),
  };
}

function createPostgresStorage(pool) {
  async function writeTask(queryable, task, { upsert = true } = {}) {
    const status = task.status === 'waiting' ? 'scheduled' : task.status;
    // Fingerprints are only useful when the corresponding safe, human-readable summary exists.
    // Keep each pair atomic so a later review never asks the user to approve an opaque hash.
    const acceptedConfigFingerprint=task.acceptedConfigFingerprint&&task.acceptedConfigSummary
      ?task.acceptedConfigFingerprint:null;
    const acceptedConfigSummary=acceptedConfigFingerprint?task.acceptedConfigSummary:null;
    const lastObservedConfigFingerprint=task.lastObservedConfigFingerprint&&task.lastObservedConfigSummary
      ?task.lastObservedConfigFingerprint:acceptedConfigFingerprint;
    const lastObservedConfigSummary=lastObservedConfigFingerprint
      ?(task.lastObservedConfigSummary||acceptedConfigSummary):null;
    const conflict = upsert ? `ON CONFLICT (user_id,id) DO UPDATE SET name=EXCLUDED.name,
        wallet_label=EXCLUDED.wallet_label,contract_address=EXCLUDED.contract_address,
        function_name=EXCLUDED.function_name,quantity=EXCLUDED.quantity,price_eth=EXCLUDED.price_eth,
        gas_gwei=EXCLUDED.gas_gwei,mint_time=EXCLUDED.mint_time,status=EXCLUDED.status,
        next_attempt_at=EXCLUDED.next_attempt_at,max_attempts=EXCLUDED.max_attempts,
        via_opensea=EXCLUDED.via_opensea,stage_type=EXCLUDED.stage_type,chain=EXCLUDED.chain,
        stage_uuid=EXCLUDED.stage_uuid,stage_label=EXCLUDED.stage_label,
        eligibility_mode=EXCLUDED.eligibility_mode,eligibility_deadline=EXCLUDED.eligibility_deadline,
        wallet_address=EXCLUDED.wallet_address,reservation_stage_key=EXCLUDED.reservation_stage_key,
        allowance_scope=EXCLUDED.allowance_scope,
        allowance_max_per_wallet=EXCLUDED.allowance_max_per_wallet,
        allowance_minted_snapshot=EXCLUDED.allowance_minted_snapshot,
        allowance_source=EXCLUDED.allowance_source,
        allowance_verified_at=EXCLUDED.allowance_verified_at,
        allowance_stage_start_at=EXCLUDED.allowance_stage_start_at,
        original_opening_at=EXCLUDED.original_opening_at,
        time_change_policy=EXCLUDED.time_change_policy,
        max_opening_delay_ms=EXCLUDED.max_opening_delay_ms,
        price_change_policy=EXCLUDED.price_change_policy,
        max_price_wei_per_item=EXCLUDED.max_price_wei_per_item,
        preflight_target_at=EXCLUDED.preflight_target_at,
        preflight_generation=CASE WHEN mint_tasks.preflight_target_at IS DISTINCT FROM EXCLUDED.preflight_target_at
          THEN mint_tasks.preflight_generation+1 ELSE mint_tasks.preflight_generation END` : '';
    return queryable.query(`INSERT INTO mint_tasks
      (user_id,id,name,wallet_label,contract_address,function_name,quantity,price_eth,gas_gwei,mint_time,status,created_at,
        next_attempt_at,max_attempts,idempotency_key,via_opensea,stage_type,chain,stage_uuid,stage_label,
        eligibility_mode,eligibility_deadline,wallet_address,reservation_stage_key,
        allowance_scope,allowance_max_per_wallet,allowance_minted_snapshot,allowance_source,
        allowance_verified_at,allowance_stage_start_at,
        preflight_target_at,preflight_generation,
        original_opening_at,accepted_opening_at,last_observed_opening_at,
        time_change_policy,max_opening_delay_ms,accepted_price_wei_per_item,
        last_observed_price_wei_per_item,price_change_policy,max_price_wei_per_item,
        accepted_config_fingerprint,last_observed_config_fingerprint,
        accepted_config_summary,last_observed_config_summary,change_state,change_version,
        pending_change,change_detected_at,change_review_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TO_TIMESTAMP($10 / 1000.0),$11,TO_TIMESTAMP($12 / 1000.0),
        TO_TIMESTAMP($13 / 1000.0),$14,$15,$16,$17,$18,$19,$20,$21,
        CASE WHEN $22::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($22 / 1000.0) END,$23,$24,
        $25,$26,$27,$28,
        CASE WHEN $29::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($29 / 1000.0) END,
        CASE WHEN $30::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($30 / 1000.0) END,
        TO_TIMESTAMP($31 / 1000.0),$32,
        TO_TIMESTAMP($33 / 1000.0),TO_TIMESTAMP($34 / 1000.0),
        CASE WHEN $35::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($35 / 1000.0) END,
        $36,$37,$38,$39,$40,$41,$42,$43,$44::JSONB,$45::JSONB,$46,$47,$48,
        CASE WHEN $49::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($49 / 1000.0) END,
        CASE WHEN $50::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($50 / 1000.0) END)
      ${conflict}
      RETURNING *`,
    [task.userId, task.id, task.name, task.walletLabel, task.contract, task.fn || 'mint', task.qty,
      task.price || 0, task.gas ?? null, task.mintTime, status, task.createdAt || Date.now(),
      task.nextAttemptAt || task.mintTime, task.maxAttempts || 3,
      task.idempotencyKey || `scheduled-mint:${task.userId}:${task.id}`, Boolean(task.viaOpenSea),
      task.stageType ?? null, task.chain ?? null, task.stageUuid ?? null, task.stageLabel ?? null,
      task.eligibilityMode ?? 'specific_stage', task.eligibilityDeadline ?? null,
      task.walletAddress ?? null, task.reservationStageKey ?? null,
      task.allowanceScope ?? 'unknown',task.allowanceMaxPerWallet ?? null,
      task.allowanceMintedSnapshot ?? null,task.allowanceSource ?? null,
      task.allowanceVerifiedAt ?? null,task.allowanceStageStartAt ?? task.stageStartAt ?? task.mintTime,
      task.preflightTargetAt ?? task.nextAttemptAt ?? task.mintTime,task.preflightGeneration??1,
      task.originalOpeningAt ?? task.stageStartAt ?? task.mintTime,
      task.acceptedOpeningAt ?? task.stageStartAt ?? task.mintTime,
      task.lastObservedOpeningAt ?? task.acceptedOpeningAt ?? task.stageStartAt ?? task.mintTime,
      task.timeChangePolicy ?? 'approval',task.maxOpeningDelayMs ?? null,
      task.acceptedPriceWeiPerItem ?? null,task.lastObservedPriceWeiPerItem ?? task.acceptedPriceWeiPerItem ?? null,
      task.priceChangePolicy ?? 'approval',task.maxPriceWeiPerItem ?? null,
      acceptedConfigFingerprint,lastObservedConfigFingerprint,
      acceptedConfigSummary ? JSON.stringify(acceptedConfigSummary) : null,
      lastObservedConfigSummary ? JSON.stringify(lastObservedConfigSummary) : null,
      task.changeState ?? 'clear',task.changeVersion ?? 0,
      task.pendingChange ? JSON.stringify(task.pendingChange) : null,task.changeDetectedAt ?? null,
      task.changeReviewExpiresAt ?? null]);
  }

  async function loadState(userId = null) {
    const where = userId ? ' WHERE user_id=$1' : '';
    const values = userId ? [userId] : [];
    const [wallets, tasks, activity, pnl, snipers] = await Promise.all([
      pool.query(`SELECT * FROM wallets${where} ORDER BY id`, values),
      pool.query(`SELECT * FROM mint_tasks${where} ORDER BY created_at`, values),
      pool.query(`SELECT * FROM activity${where} ORDER BY occurred_at DESC LIMIT 200`, values),
      pool.query(`SELECT * FROM pnl_records${where} ORDER BY created_at DESC`, values),
      pool.query(`SELECT * FROM snipers${where}${where?' AND':' WHERE'} archived_at IS NULL ORDER BY created_at`, values),
    ]);
    return { wallets: wallets.rows.map(mapWallet), tasks: tasks.rows.map(mapTask),
      activity: activity.rows.map(mapActivity), pnl: pnl.rows.map(mapPnl), snipers: snipers.rows.map(mapSniper) };
  }

  return {
    async health() {
      const result = await pool.query('SELECT 1 AS connected');
      return result.rows[0]?.connected === 1;
    },
    loadState,
    loadSystemState() { return loadState(); },
    async listActivityPage(userId,{limit,offset,search}) {
      const term=search?`%${search}%`:null;
      const mainWhere=term?'WHERE user_id=$1 AND (title ILIKE $4 OR wallet_label ILIKE $4)':'WHERE user_id=$1';
      const mainParams=term?[userId,limit,offset,term]:[userId,limit,offset];
      const countWhere=term?'WHERE user_id=$1 AND (title ILIKE $2 OR wallet_label ILIKE $2)':'WHERE user_id=$1';
      const countParams=term?[userId,term]:[userId];
      const qualifiedMainWhere=mainWhere.replaceAll('user_id','activity.user_id')
        .replaceAll('title','activity.title').replaceAll('wallet_label','activity.wallet_label');
      const [rows,count]=await Promise.all([pool.query(`SELECT activity.*,
        transaction_intents.chain AS transaction_chain,
        transaction_intents.to_address AS transaction_address,
        transaction_intents.value_wei AS transaction_value_wei,
        transaction_intents.token_ids AS transaction_token_ids,
        transaction_intents.trigger_source AS transaction_trigger_source,
        contract_value_cache.opensea_name AS collection_name FROM activity
        LEFT JOIN transaction_intents ON transaction_intents.user_id=activity.user_id
          AND transaction_intents.tx_hash=activity.tx_hash
        LEFT JOIN contract_value_cache ON contract_value_cache.chain=transaction_intents.chain
          AND contract_value_cache.contract_address=LOWER(COALESCE(
            transaction_intents.call_preview->>'contractAddress',activity.address,transaction_intents.to_address))
        ${qualifiedMainWhere}
        ORDER BY activity.occurred_at DESC,activity.id DESC LIMIT $2 OFFSET $3`,mainParams),
      pool.query(`SELECT COUNT(*)::INTEGER AS total FROM activity ${countWhere}`,countParams)]);
      return {items:rows.rows.map(mapActivity),total:count.rows[0].total};
    },

    async addWallet(wallet) {
      const e = wallet.keyEnvelope;
      const result = await pool.query(`INSERT INTO wallets
        (user_id,label,address,chain,encrypted_private_key,encryption_salt,encryption_nonce,
          encryption_auth_tag,encryption_key_version,minted,added_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TO_TIMESTAMP($11 / 1000.0)) RETURNING *`,
      [wallet.userId, wallet.label, wallet.address, wallet.chain, e.ciphertext, e.salt, e.nonce,
        e.authTag, e.keyVersion, wallet.minted || 0, wallet.addedAt]);
      return mapWallet(result.rows[0]);
    },
    async deleteWallet(userId, label) {
      const result = await pool.query('DELETE FROM wallets WHERE user_id=$1 AND label=$2', [userId, label]);
      return result.rowCount > 0;
    },
    async updateWalletMinted(userId, label, minted) {
      const result = await pool.query('UPDATE wallets SET minted=$3 WHERE user_id=$1 AND label=$2', [userId, label, minted]);
      return result.rowCount > 0;
    },
    async updateWalletEnvelope(userId, id, envelope) {
      const result = await pool.query(`UPDATE wallets SET encrypted_private_key=$3,encryption_salt=$4,
        encryption_nonce=$5,encryption_auth_tag=$6,encryption_key_version=$7 WHERE user_id=$1 AND id=$2`,
      [userId, id, envelope.ciphertext, envelope.salt, envelope.nonce, envelope.authTag, envelope.keyVersion]);
      return result.rowCount > 0;
    },
    async getWallet(userId, id) {
      const result = await pool.query('SELECT * FROM wallets WHERE user_id=$1 AND id=$2', [userId, id]);
      return result.rowCount ? mapWallet(result.rows[0]) : null;
    },

    async saveTask(task) {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const result=await writeTask(client,task);
        if(result.rowCount)await armTaskPreflightRows(client,result.rows[0]);
        await client.query('COMMIT');
        return result.rowCount>0;
      } catch(error) {
        await client.query('ROLLBACK').catch(()=>{});
        throw error;
      } finally { client.release(); }
    },
    async createReservedTask(task) {
      if (!task.walletAddress || !task.chain || !task.reservationStageKey) {
        throw new TypeError('A schedule reservation requires walletAddress, chain, and reservationStageKey');
      }
      const client = await pool.connect();
      const lockKey = [task.userId,task.walletAddress.toLowerCase(),task.chain.toLowerCase(),task.contract.toLowerCase()].join('|');
      try {
        await client.query('BEGIN');
        // Lock the whole wallet+chain+contract envelope, not just one stage. A later cumulative-cap
        // pass can safely inspect every phase under this same serialization boundary.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey]);
        const active = await client.query(`SELECT task.* FROM mint_tasks task
          LEFT JOIN wallets wallet ON wallet.user_id=task.user_id
            AND LOWER(wallet.label)=LOWER(task.wallet_label)
          WHERE task.user_id=$1
            AND LOWER(COALESCE(NULLIF(task.wallet_address,''),wallet.address))=LOWER($2)
            AND LOWER(COALESCE(NULLIF(task.chain,''),wallet.chain))=LOWER($3)
            AND LOWER(task.contract_address)=LOWER($4)
            AND task.status IN ('scheduled','claimed','retry','paused')
          ORDER BY task.created_at,task.id FOR UPDATE OF task`,
        [task.userId,task.walletAddress,task.chain,task.contract]);
        const activeTasks = active.rows.map(mapTask);
        const conflict = activeTasks.find(existing => {
          const key = existing.reservationStageKey || scheduleReservationStageKey({
            stageUuid:existing.stageUuid,stageLabel:existing.stageLabel,
            stageType:existing.stageType,mintTime:existing.mintTime,
          });
          return key === task.reservationStageKey;
        });
        if (conflict) {
          await client.query('COMMIT');
          return { created:false, conflict };
        }
        enforceScheduleAllowanceEnvelope(activeTasks,task);
        const inserted = await writeTask(client, task, { upsert:false });
        await armTaskPreflightRows(client,inserted.rows[0]);
        await client.query('COMMIT');
        return { created:true, task:mapTask(inserted.rows[0]) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error?.code==='23505'&&error?.constraint==='mint_tasks_active_wallet_contract_stage_uniq') {
          const conflict=new Error('This wallet already has an active mint scheduled for this stage.');
          conflict.code='SCHEDULE_STAGE_DUPLICATE';
          throw conflict;
        }
        throw error;
      } finally { client.release(); }
    },
    async deleteTask(userId, id) {
      const result = await pool.query('DELETE FROM mint_tasks WHERE user_id=$1 AND id=$2', [userId, id]);
      return result.rowCount > 0;
    },

    async addActivity(entry) {
      const result = await pool.query(`INSERT INTO activity
        (user_id,status,title,wallet_label,tx_hash,explorer,occurred_at,actual_network_cost_wei,trigger_source,verification_state,address)
        VALUES ($1,$2,$3,$4,$5,$6,TO_TIMESTAMP($7 / 1000.0),$8,$9,$10,$11) RETURNING *`,
      [entry.userId, entry.status, entry.title, entry.walletLabel, entry.txHash, entry.explorer, entry.time,
        entry.actualNetworkCostWei?.toString()??null,entry.triggerSource??null,entry.verificationState??null,entry.address??null]);
      return mapActivity(result.rows[0]);
    },
    async addPnl(record) {
      const result = await pool.query(`INSERT INTO pnl_records (user_id,name,cost,sale,gas,net,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,TO_TIMESTAMP($7 / 1000.0)) RETURNING *`,
      [record.userId, record.nm, record.cost, record.sale, record.gas, record.net, record.t]);
      return mapPnl(result.rows[0]);
    },
    async updatePnl(userId,id,record) {
      const result=await pool.query(`UPDATE pnl_records SET name=$3,cost=$4,sale=$5,gas=$6,net=$7
        WHERE user_id=$1 AND id=$2 RETURNING *`,[userId,id,record.nm,record.cost,record.sale,record.gas,record.net]);
      return mapPnl(result.rows[0]);
    },
    async deletePnl(userId, id) {
      const result = await pool.query('DELETE FROM pnl_records WHERE user_id=$1 AND id=$2', [userId, id]);
      return result.rowCount > 0;
    },

    async saveSniper(sniper) {
      const result = await pool.query(`INSERT INTO snipers
        (user_id,id,label,target_address,chain,wallet_label,value_mode,fixed_value_eth,max_value_eth,
          gas_boost_percent,max_gas_gwei,daily_spending_cap_eth,cooldown_ms,max_attempts,
          contract_allowlist,contract_denylist,source_confirmations,observation_mode,active,hits,fails,last_fired_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
          CASE WHEN $22::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($22 / 1000.0) END,
          TO_TIMESTAMP($23 / 1000.0))
        ON CONFLICT (user_id,id) DO UPDATE SET label=EXCLUDED.label,target_address=EXCLUDED.target_address,
        chain=EXCLUDED.chain,wallet_label=EXCLUDED.wallet_label,value_mode=EXCLUDED.value_mode,
        fixed_value_eth=EXCLUDED.fixed_value_eth,max_value_eth=EXCLUDED.max_value_eth,
        gas_boost_percent=EXCLUDED.gas_boost_percent,max_gas_gwei=EXCLUDED.max_gas_gwei,
        daily_spending_cap_eth=EXCLUDED.daily_spending_cap_eth,cooldown_ms=EXCLUDED.cooldown_ms,
        max_attempts=EXCLUDED.max_attempts,contract_allowlist=EXCLUDED.contract_allowlist,
        contract_denylist=EXCLUDED.contract_denylist,source_confirmations=EXCLUDED.source_confirmations,
        observation_mode=EXCLUDED.observation_mode,
        active=EXCLUDED.active,hits=EXCLUDED.hits,
        fails=EXCLUDED.fails,last_fired_at=EXCLUDED.last_fired_at
        RETURNING id`,
      [sniper.userId, sniper.id, sniper.label, sniper.targetAddress, sniper.chain, sniper.walletLabel,
        sniper.valueMode, sniper.fixedValueETH || 0, sniper.maxValueETH ?? 0.1, sniper.gasBoostPercent ?? 20,
        sniper.maxGasGwei ?? 200, sniper.dailySpendingCapETH ?? 0.25, sniper.cooldownMs ?? 60_000,
        sniper.maxAttempts ?? 3, sniper.contractAllowlist || [], sniper.contractDenylist || [],
        sniper.sourceConfirmations ?? 2, sniper.observationMode || 'confirmed', sniper.active, sniper.hits || 0, sniper.fails || 0,
        sniper.lastFiredAt, sniper.createdAt || Date.now()]);
      return result.rowCount > 0;
    },
    async deleteSniper(userId, id) {
      const result = await pool.query(`UPDATE snipers SET archived_at=NOW(),active=FALSE
        WHERE user_id=$1 AND id=$2 AND archived_at IS NULL`, [userId, id]);
      return result.rowCount > 0;
    },
    close() { return pool.end(); },
  };
}

module.exports = { createPostgresStorage };
