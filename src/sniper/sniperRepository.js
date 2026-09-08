function number(value) { return value === null ? null : Number(value); }
function time(value) { return value === null ? null : new Date(value).getTime(); }
function bigint(value) { return value === null || value === undefined ? null : BigInt(value); }
function dbInteger(value) { return value === null || value === undefined ? null : String(value); }

function mapEvent(row) {
  if (!row) return null;
  return {
    userId:row.user_id, sniperId:row.sniper_id, txHash:row.tx_hash, state:row.state,
    sourceBlockNumber:number(row.source_block_number), sourceBlockHash:row.source_block_hash,
    observationMode:row.observation_mode || 'confirmed', sourceSender:row.source_sender,
    sourceNonce:row.source_nonce, sourceKey:row.source_key, sourceCurrentHash:row.source_current_hash || row.tx_hash,
    sourceData:row.source_data, sourceValueWei:bigint(row.source_value_wei),
    sourceGasPriceWei:bigint(row.source_gas_price_wei), sourceMaxFeePerGasWei:bigint(row.source_max_fee_per_gas_wei),
    sourceMaxPriorityFeePerGasWei:bigint(row.source_max_priority_fee_per_gas_wei),
    sourceGasLimit:bigint(row.source_gas_limit), reservedNetworkCostWei:bigint(row.reserved_network_cost_wei),
    actualNetworkCostWei:bigint(row.actual_network_cost_wei),
    estimatedTotalCostWei:bigint(row.estimated_cost_wei),
    contractAddress:row.contract_address, copiedValueWei:row.copied_value_wei === null ? null : BigInt(row.copied_value_wei),
    attemptCount:row.attempt_count, skipReason:row.skip_reason, failureReason:row.failure_reason,
    retryable:row.retryable, transactionIntentId:row.transaction_intent_id,
    claimExpiresAt:time(row.claim_expires_at), seenAt:time(row.seen_at), updatedAt:time(row.updated_at),
  };
}

function createSniperRepository(pool) {
  return {
    async detect(sniper, tx) {
      const observationMode = sniper.observationMode || 'confirmed';
      const sourceSender = tx.from ? String(tx.from).toLowerCase() : null;
      const sourceNonce = tx.nonce === undefined || tx.nonce === null ? null : String(tx.nonce);
      const sourceKey = observationMode === 'pending' && sourceSender && sourceNonce !== null
        ? `${sourceSender}:${sourceNonce}` : null;
      const sourceData = observationMode === 'pending' ? (tx.data || tx.input || null) : null;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (sourceKey) {
          const existing = await client.query(`SELECT * FROM sniper_seen_transactions
            WHERE user_id=$1 AND sniper_id=$2 AND source_key=$3 FOR UPDATE`,
          [sniper.userId, sniper.id, sourceKey]);
          if (existing.rowCount) {
            const current = existing.rows[0];
            if (current.source_current_hash === tx.hash || current.state !== 'detected') {
              await client.query('COMMIT');
              return null;
            }
            const replacement = await client.query(`UPDATE sniper_seen_transactions SET
              source_current_hash=$4,contract_address=$5,source_data=$6,source_value_wei=$7,
              source_gas_price_wei=$8,source_max_fee_per_gas_wei=$9,
              source_max_priority_fee_per_gas_wei=$10,source_gas_limit=$11,updated_at=NOW()
              WHERE user_id=$1 AND sniper_id=$2 AND source_key=$3 AND state='detected' RETURNING *`,
            [sniper.userId, sniper.id, sourceKey, tx.hash, tx.to, sourceData,
              dbInteger(tx.value), dbInteger(tx.gasPrice), dbInteger(tx.maxFeePerGas),
              dbInteger(tx.maxPriorityFeePerGas), dbInteger(tx.gasLimit || tx.gas)]);
            if (replacement.rowCount) await client.query(`INSERT INTO sniper_event_transitions
              (user_id,sniper_id,tx_hash,state,reason) VALUES ($1,$2,$3,'detected',$4)`,
            [sniper.userId, sniper.id, current.tx_hash,
              `pending source transaction replacement observed (${tx.hash})`]);
            await client.query('COMMIT');
            return mapEvent(replacement.rows[0]);
          }
        }
        const result = await client.query(`INSERT INTO sniper_seen_transactions
        (user_id,sniper_id,tx_hash,state,source_block_number,source_block_hash,contract_address,
          observation_mode,source_sender,source_nonce,source_key,source_current_hash,source_data,
          source_value_wei,source_gas_price_wei,source_max_fee_per_gas_wei,
          source_max_priority_fee_per_gas_wei,source_gas_limit)
        VALUES ($1,$2,$3,'detected',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT DO NOTHING RETURNING *`,
        [sniper.userId, sniper.id, tx.hash, tx.blockNumber ?? null, tx.blockHash ?? null, tx.to,
          observationMode, sourceSender, sourceNonce, sourceKey, tx.hash, sourceData,
          dbInteger(tx.value), dbInteger(tx.gasPrice), dbInteger(tx.maxFeePerGas),
          dbInteger(tx.maxPriorityFeePerGas), dbInteger(tx.gasLimit || tx.gas)]);
        if (result.rowCount) await client.query(`INSERT INTO sniper_event_transitions
          (user_id,sniper_id,tx_hash,state,reason) VALUES ($1,$2,$3,'detected',$4)`,
        [sniper.userId, sniper.id, tx.hash, observationMode === 'pending'
          ? 'source transaction detected in the public mempool' : 'source transaction detected in a confirmed block']);
        await client.query('COMMIT');
        return mapEvent(result.rows[0]);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async listReady(chain, currentBlock, snipers) {
      if (!snipers.length) return [];
      const pairs = snipers.map(sniper => [sniper.userId, sniper.id, sniper.sourceConfirmations]);
      const result = await pool.query(`SELECT event.* FROM sniper_seen_transactions event
        JOIN snipers sniper ON sniper.user_id=event.user_id AND sniper.id=event.sniper_id
        WHERE event.state='detected' AND sniper.chain=$1 AND sniper.active=TRUE
          AND ((event.observation_mode='confirmed'
              AND event.source_block_number + sniper.source_confirmations - 1 <= $2)
            OR (event.observation_mode='pending' AND event.source_data IS NOT NULL))
          AND (event.user_id,event.sniper_id) IN (SELECT (value->>0)::UUID,(value->>1)::UUID FROM JSONB_ARRAY_ELEMENTS($3::JSONB) value)
        ORDER BY event.source_block_number NULLS LAST,event.seen_at`, [chain, currentBlock, JSON.stringify(pairs)]);
      return result.rows.map(mapEvent);
    },

    async listSubmitted(chain) {
      const result = await pool.query(`SELECT event.* FROM sniper_seen_transactions event
        JOIN snipers sniper ON sniper.user_id=event.user_id AND sniper.id=event.sniper_id
        WHERE event.state='submitted' AND sniper.chain=$1
          AND (event.transaction_intent_id IS NOT NULL OR event.claim_expires_at<=NOW())
        ORDER BY event.updated_at`, [chain]);
      return result.rows.map(mapEvent);
    },

    async claim(event, options) {
      const maxAttempts = typeof options === 'number' ? options : options.maxAttempts;
      const nowMs = typeof options === 'number' ? Date.now() : options.nowMs;
      const cooldownMs = typeof options === 'number' ? 0 : options.cooldownMs;
      const dailyCapWei = typeof options === 'number' ? null : BigInt(options.dailyCapWei);
      const copiedValueWei = typeof options === 'number' ? 0n : BigInt(options.copiedValueWei);
      const reservedNetworkCostWei = typeof options === 'number' ? 0n : BigInt(options.reservedNetworkCostWei || 0);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query(`SELECT active,archived_at,last_fired_at FROM snipers
          WHERE user_id=$1 AND id=$2 FOR UPDATE`, [event.userId, event.sniperId]);
        if (!locked.rowCount || !locked.rows[0].active || locked.rows[0].archived_at) {
          await client.query('COMMIT');
          return { event:null, reason:'sniper is no longer active', terminal:true };
        }
        const lastFiredAt = time(locked.rows[0].last_fired_at);
        if (lastFiredAt && nowMs - lastFiredAt < cooldownMs) {
          await client.query('COMMIT');
          return { event:null, reason:'sniper cooldown is active', terminal:true };
        }
        if (dailyCapWei !== null) {
          const spend = await client.query(`SELECT COALESCE(SUM(CASE
              WHEN intent.actual_network_cost_wei IS NOT NULL THEN
                COALESCE(event.copied_value_wei,intent.value_wei,0)+intent.actual_network_cost_wei
              WHEN intent.estimated_cost_wei IS NOT NULL THEN intent.estimated_cost_wei
              ELSE COALESCE(event.copied_value_wei,0)+COALESCE(event.reserved_network_cost_wei,0)
            END),0) AS total
            FROM sniper_seen_transactions event LEFT JOIN transaction_intents intent
              ON intent.intent_id=event.transaction_intent_id
            WHERE event.user_id=$1 AND event.sniper_id=$2
              AND event.state IN ('submitted','confirmed')
              AND event.updated_at>=TO_TIMESTAMP($3 / 1000.0)`,
          [event.userId, event.sniperId, nowMs - 86_400_000]);
          if (BigInt(spend.rows[0].total) + copiedValueWei + reservedNetworkCostWei > dailyCapWei) {
            await client.query('COMMIT');
            return { event:null, reason:'daily sniper spending cap exceeded', terminal:true };
          }
        }
        const result = await client.query(`UPDATE sniper_seen_transactions SET state='submitted',attempt_count=attempt_count+1,
        retryable=FALSE,failure_reason=NULL,copied_value_wei=$5,reserved_network_cost_wei=$6,
        claim_expires_at=NOW()+INTERVAL '30 seconds',updated_at=NOW()
        WHERE user_id=$1 AND sniper_id=$2 AND tx_hash=$3
        AND state='detected' AND attempt_count<$4 RETURNING *`,
        [event.userId, event.sniperId, event.txHash, maxAttempts,
          String(copiedValueWei), String(reservedNetworkCostWei)]);
        if (result.rowCount) await client.query(`INSERT INTO sniper_event_transitions
          (user_id,sniper_id,tx_hash,state,reason) VALUES ($1,$2,$3,'submitted','copy attempt claimed')`,
        [event.userId, event.sniperId, event.txHash]);
        if (result.rowCount) await client.query(`UPDATE snipers SET last_fired_at=TO_TIMESTAMP($3/1000.0)
          WHERE user_id=$1 AND id=$2`, [event.userId, event.sniperId, nowMs]);
        await client.query('COMMIT');
        return result.rowCount ? { event:mapEvent(result.rows[0]), reason:null, terminal:false }
          : { event:null, reason:null, terminal:false };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async transition(event, state, details = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE sniper_seen_transactions SET state=$4,
        skip_reason=$5,failure_reason=$6,retryable=$7,transaction_intent_id=COALESCE($8,transaction_intent_id),
        copied_value_wei=COALESCE($9,copied_value_wei),
        claim_expires_at=CASE WHEN $4<>'submitted' OR $8 IS NOT NULL THEN NULL ELSE claim_expires_at END,
        updated_at=NOW()
        WHERE user_id=$1 AND sniper_id=$2 AND tx_hash=$3
          AND ($10::TEXT[] IS NULL OR state=ANY($10::TEXT[])) RETURNING *`,
      [event.userId, event.sniperId, event.txHash, state, details.skipReason || null,
        details.failureReason || null, details.retryable || false, details.intentId || null,
        details.valueWei === undefined ? null : String(details.valueWei), details.expectedStates || null]);
        if (result.rowCount) await client.query(`INSERT INTO sniper_event_transitions
          (user_id,sniper_id,tx_hash,state,reason) VALUES ($1,$2,$3,$4,$5)`,
        [event.userId, event.sniperId, event.txHash, state, details.skipReason || details.failureReason || null]);
        await client.query('COMMIT');
        return mapEvent(result.rows[0]);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async attachIntent(event, intentId, valueWei) {
      const result = await pool.query(`UPDATE sniper_seen_transactions SET
        transaction_intent_id=$4,copied_value_wei=COALESCE($5,copied_value_wei),
        claim_expires_at=NULL,updated_at=NOW()
        WHERE user_id=$1 AND sniper_id=$2 AND tx_hash=$3 AND state='submitted' RETURNING *`,
      [event.userId, event.sniperId, event.txHash, intentId,
        valueWei === undefined ? null : String(valueWei)]);
      return mapEvent(result.rows[0]);
    },

    async requeueRetryable(event, maxAttempts) {
      const result = await pool.query(`UPDATE sniper_seen_transactions SET state='detected',updated_at=NOW()
        ,claim_expires_at=NULL
        WHERE user_id=$1 AND sniper_id=$2 AND tx_hash=$3 AND state='failed' AND retryable=TRUE
        AND attempt_count<$4 RETURNING *`, [event.userId, event.sniperId, event.txHash, maxAttempts]);
      return mapEvent(result.rows[0]);
    },

    async dailySpendWei(userId, sniperId, since) {
      const result = await pool.query(`SELECT COALESCE(SUM(CASE
          WHEN intent.actual_network_cost_wei IS NOT NULL THEN
            COALESCE(event.copied_value_wei,intent.value_wei,0)+intent.actual_network_cost_wei
          WHEN intent.estimated_cost_wei IS NOT NULL THEN intent.estimated_cost_wei
          ELSE COALESCE(event.copied_value_wei,0)+COALESCE(event.reserved_network_cost_wei,0)
        END),0) AS total
        FROM sniper_seen_transactions event LEFT JOIN transaction_intents intent
          ON intent.intent_id=event.transaction_intent_id
        WHERE event.user_id=$1 AND event.sniper_id=$2 AND event.state IN ('submitted','confirmed')
          AND event.updated_at>=TO_TIMESTAMP($3 / 1000.0)`, [userId, sniperId, since]);
      return BigInt(result.rows[0].total);
    },

    async get(userId, sniperId, txHash) {
      const result = await pool.query(`SELECT * FROM sniper_seen_transactions
        WHERE user_id=$1 AND sniper_id=$2 AND tx_hash=$3`, [userId, sniperId, txHash]);
      return mapEvent(result.rows[0]);
    },
    async statsForUser(userId) {
      const result=await pool.query(`SELECT state,COUNT(*)::INTEGER AS count FROM sniper_seen_transactions
        WHERE user_id=$1 GROUP BY state`,[userId]);
      return result.rows.map(row=>({state:row.state,count:row.count}));
    },
    async listRecentForUser(userId,limit=100) {
      const result=await pool.query(`SELECT event.*,intent.actual_network_cost_wei,intent.estimated_cost_wei
        FROM sniper_seen_transactions event LEFT JOIN transaction_intents intent
          ON intent.intent_id=event.transaction_intent_id AND intent.user_id=event.user_id
        WHERE event.user_id=$1 ORDER BY event.updated_at DESC LIMIT $2`,[userId,limit]);
      return result.rows.map(mapEvent);
    },
  };
}

module.exports = { createSniperRepository, mapEvent };
