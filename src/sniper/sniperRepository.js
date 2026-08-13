function number(value) { return value === null ? null : Number(value); }
function time(value) { return value === null ? null : new Date(value).getTime(); }

function mapEvent(row) {
  if (!row) return null;
  return {
    userId:row.user_id, sniperId:row.sniper_id, txHash:row.tx_hash, state:row.state,
    sourceBlockNumber:number(row.source_block_number), sourceBlockHash:row.source_block_hash,
    contractAddress:row.contract_address, copiedValueWei:row.copied_value_wei === null ? null : BigInt(row.copied_value_wei),
    attemptCount:row.attempt_count, skipReason:row.skip_reason, failureReason:row.failure_reason,
    retryable:row.retryable, transactionIntentId:row.transaction_intent_id,
    seenAt:time(row.seen_at), updatedAt:time(row.updated_at),
  };
}

function createSniperRepository(pool) {
  return {
    async detect(sniper, tx) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`INSERT INTO sniper_seen_transactions
        (user_id,sniper_id,tx_hash,state,source_block_number,source_block_hash,contract_address)
        VALUES ($1,$2,$3,'detected',$4,$5,$6) ON CONFLICT (user_id,sniper_id,tx_hash) DO NOTHING RETURNING *`,
        [sniper.userId, sniper.id, tx.hash, tx.blockNumber, tx.blockHash, tx.to]);
        if (result.rowCount) await client.query(`INSERT INTO sniper_event_transitions
          (user_id,sniper_id,tx_hash,state,reason) VALUES ($1,$2,$3,'detected','source transaction detected')`,
        [sniper.userId, sniper.id, tx.hash]);
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
          AND event.source_block_number + sniper.source_confirmations - 1 <= $2
          AND (event.user_id,event.sniper_id) IN (SELECT (value->>0)::UUID,(value->>1)::UUID FROM JSONB_ARRAY_ELEMENTS($3::JSONB) value)
        ORDER BY event.source_block_number,event.seen_at`, [chain, currentBlock, JSON.stringify(pairs)]);
      return result.rows.map(mapEvent);
    },

    async listSubmitted(chain) {
      const result = await pool.query(`SELECT event.* FROM sniper_seen_transactions event
        JOIN snipers sniper ON sniper.user_id=event.user_id AND sniper.id=event.sniper_id
        WHERE event.state='submitted' AND sniper.chain=$1 ORDER BY event.updated_at`, [chain]);
      return result.rows.map(mapEvent);
    },

    async claim(event, maxAttempts) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE sniper_seen_transactions SET state='submitted',attempt_count=attempt_count+1,
        retryable=FALSE,failure_reason=NULL,updated_at=NOW() WHERE user_id=$1 AND sniper_id=$2 AND tx_hash=$3
        AND state='detected' AND attempt_count<$4 RETURNING *`,
        [event.userId, event.sniperId, event.txHash, maxAttempts]);
        if (result.rowCount) await client.query(`INSERT INTO sniper_event_transitions
          (user_id,sniper_id,tx_hash,state,reason) VALUES ($1,$2,$3,'submitted','copy attempt claimed')`,
        [event.userId, event.sniperId, event.txHash]);
        await client.query('COMMIT');
        return mapEvent(result.rows[0]);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async transition(event, state, details = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`UPDATE sniper_seen_transactions SET state=$4,
        skip_reason=$5,failure_reason=$6,retryable=$7,transaction_intent_id=COALESCE($8,transaction_intent_id),
        copied_value_wei=COALESCE($9,copied_value_wei),updated_at=NOW()
        WHERE user_id=$1 AND sniper_id=$2 AND tx_hash=$3 RETURNING *`,
      [event.userId, event.sniperId, event.txHash, state, details.skipReason || null,
        details.failureReason || null, details.retryable || false, details.intentId || null,
        details.valueWei === undefined ? null : String(details.valueWei)]);
        if (result.rowCount) await client.query(`INSERT INTO sniper_event_transitions
          (user_id,sniper_id,tx_hash,state,reason) VALUES ($1,$2,$3,$4,$5)`,
        [event.userId, event.sniperId, event.txHash, state, details.skipReason || details.failureReason || null]);
        await client.query('COMMIT');
        return mapEvent(result.rows[0]);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },

    async requeueRetryable(event, maxAttempts) {
      const result = await pool.query(`UPDATE sniper_seen_transactions SET state='detected',updated_at=NOW()
        WHERE user_id=$1 AND sniper_id=$2 AND tx_hash=$3 AND state='failed' AND retryable=TRUE
        AND attempt_count<$4 RETURNING *`, [event.userId, event.sniperId, event.txHash, maxAttempts]);
      return mapEvent(result.rows[0]);
    },

    async dailySpendWei(userId, sniperId, since) {
      const result = await pool.query(`SELECT COALESCE(SUM(COALESCE(intent.actual_network_cost_wei,intent.estimated_cost_wei,event.copied_value_wei,0)),0) AS total
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
  };
}

module.exports = { createSniperRepository, mapEvent };
