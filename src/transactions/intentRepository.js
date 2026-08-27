const NON_FINAL_STATES = Object.freeze(['submitted', 'pending', 'unknown']);

function mapIntent(row) {
  if (!row) return null;
  return {
    intentId: row.intent_id,
    userId: row.user_id,
    walletId: row.wallet_id === null ? null : Number(row.wallet_id),
    targetId: row.target_id,
    chain: row.chain,
    from: row.from_address,
    to: row.to_address,
    data: row.calldata,
    valueWei: BigInt(row.value_wei),
    nonce: Number(row.nonce),
    gasLimit: BigInt(row.gas_limit),
    gasPriceWei: row.gas_price_wei === null ? null : BigInt(row.gas_price_wei),
    maxFeePerGasWei: row.max_fee_per_gas_wei === null ? null : BigInt(row.max_fee_per_gas_wei),
    maxPriorityFeePerGasWei: row.max_priority_fee_per_gas_wei === null ? null : BigInt(row.max_priority_fee_per_gas_wei),
    estimatedCostWei: BigInt(row.estimated_cost_wei),
    gasUsed: row.gas_used === null || row.gas_used === undefined ? null : BigInt(row.gas_used),
    effectiveGasPriceWei: row.effective_gas_price_wei === null || row.effective_gas_price_wei === undefined ? null : BigInt(row.effective_gas_price_wei),
    actualNetworkCostWei: row.actual_network_cost_wei === null || row.actual_network_cost_wei === undefined ? null : BigInt(row.actual_network_cost_wei),
    tokenIds: row.token_ids ?? null,
    bumpCount: row.bump_count === null || row.bump_count === undefined ? 0 : Number(row.bump_count),
    bumpedFromTxHash: row.bumped_from_tx_hash ?? null,
    triggerSource: row.trigger_source ?? null,
    simulationEnabled: row.simulation_enabled,
    requiredConfirmations: row.required_confirmations,
    transactionTimeoutMs: row.transaction_timeout_ms,
    state: row.state,
    txHash: row.tx_hash,
    replacementTxHash: row.replacement_tx_hash,
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    failureReason: row.failure_reason,
    methodSignature: row.method_signature,
    callPreview: row.call_preview,
    walletLabel: row.wallet_label ?? null,
    idempotencyKey: row.idempotency_key,
    createdAt: new Date(row.created_at).getTime(),
    timeoutAt: new Date(row.timeout_at).getTime(),
  };
}

function createTransactionIntentRepository(pool) {
  return {
    async createSubmitted(intent) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query(`INSERT INTO transaction_intents
          (user_id,wallet_id,target_id,chain,from_address,to_address,calldata,value_wei,nonce,
            gas_limit,gas_price_wei,max_fee_per_gas_wei,max_priority_fee_per_gas_wei,
          estimated_cost_wei,simulation_enabled,required_confirmations,transaction_timeout_ms,
          state,timeout_at,method_signature,call_preview,idempotency_key,trigger_source)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'submitted',
            TO_TIMESTAMP($18 / 1000.0),$19,$20::JSONB,$21,$22) RETURNING *`,
        [intent.userId, intent.walletId, intent.targetId, intent.chain, intent.from, intent.to,
          intent.data, intent.valueWei.toString(), intent.nonce, intent.gasLimit.toString(),
          intent.gasPriceWei?.toString() ?? null, intent.maxFeePerGasWei?.toString() ?? null,
          intent.maxPriorityFeePerGasWei?.toString() ?? null, intent.estimatedCostWei.toString(),
          intent.simulationEnabled, intent.requiredConfirmations, intent.transactionTimeoutMs,
          intent.timeoutAt, intent.methodSignature || null,
          intent.callPreview ? JSON.stringify(intent.callPreview) : null, intent.idempotencyKey || null,
          intent.triggerSource || 'manual']);
        const created = mapIntent(result.rows[0]);
        await client.query(`INSERT INTO transaction_state_transitions (intent_id,from_state,to_state,reason)
          VALUES ($1,NULL,'submitted','intent persisted before broadcast')`, [created.intentId]);
        await client.query('COMMIT');
        return created;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async nextNonce({ chain, from, providerNonce }) {
      const result = await pool.query(`SELECT GREATEST($3::BIGINT,
        COALESCE(MAX(nonce) + 1, $3::BIGINT)) AS nonce
        FROM transaction_intents WHERE chain=$1 AND LOWER(from_address)=LOWER($2)`,
      [chain, from, providerNonce]);
      return Number(result.rows[0].nonce);
    },

    async attachSignedHash(intentId, txHash) {
      const result = await pool.query(
        `UPDATE transaction_intents SET tx_hash=$2 WHERE intent_id=$1 AND state='submitted' RETURNING *`,
        [intentId, txHash],
      );
      return mapIntent(result.rows[0]);
    },

    // Bump-ladder candidates: pending and timed-out (unknown) intents whose current broadcast
    // has sat past the staleness window, scoped to the trigger sources the operator enabled,
    // and not already bumped to the ceiling. Unknown is included so a wallet stalled behind a
    // timed-out nonce can be rescued by the ladder instead of bricking sequential nonces.
    // Staleness measures from pending_at -- which attachBump resets on every bump -- so each
    // rung of the ladder gets its own full window.
    async listBumpCandidates({ sources, cutoffMs, maxBumpCount, limit = 25 }) {
      const result = await pool.query(
        `SELECT * FROM transaction_intents
         WHERE state IN ('pending','unknown') AND bump_count < $1
           AND trigger_source = ANY($2::TEXT[])
           AND COALESCE(pending_at, submitted_at) <= TO_TIMESTAMP($3 / 1000.0)
         ORDER BY COALESCE(pending_at, submitted_at) ASC LIMIT $4`,
        [maxBumpCount, sources, cutoffMs / 1000.0, limit],
      );
      return result.rows.map(mapIntent);
    },

    // Move an intent onto its re-bid: new hash becomes primary (the superseded one is preserved in
    // bumped_from_tx_hash), fees advance, bump_count increments, and pending_at resets so the next
    // staleness window starts from this bump rather than from the original fire.
    // TX-019 (Model 2 phase-1): the transition row must record the ACTUAL previous state -- a
    // ladder rescue from 'unknown' is unknown→pending, not a fabricated pending→pending. One
    // statement captures the locked previous state and updates atomically.
    async attachBump(intentId, { txHash, bumpedFromTxHash, gasPriceWei, maxFeePerGasWei, maxPriorityFeePerGasWei }) {
      const result = await pool.query(
        `WITH previous AS (
           SELECT intent_id, state FROM transaction_intents
           WHERE intent_id=$1 AND state IN ('pending','unknown')
           FOR UPDATE
         ), updated AS (
           UPDATE transaction_intents SET tx_hash=$2, bumped_from_tx_hash=$3,
             gas_price_wei=COALESCE($4,gas_price_wei),
             max_fee_per_gas_wei=COALESCE($5,max_fee_per_gas_wei),
             max_priority_fee_per_gas_wei=COALESCE($6,max_priority_fee_per_gas_wei),
             bump_count=bump_count+1,
             -- Each rung buys its own full timeout window: reconciliation must not declare the
             -- intent unknown mid-ladder just because the ORIGINAL broadcast is old.
             timeout_at = NOW() + (transaction_timeout_ms * INTERVAL '1 millisecond'),
             pending_at=NOW(), last_reconciled_at=NOW(), state='pending'
           WHERE intent_id=$1 AND state IN ('pending','unknown') RETURNING *
         ), logged AS (
           INSERT INTO transaction_state_transitions (intent_id, from_state, to_state, reason)
           SELECT previous.intent_id, previous.state, 'pending', 'bumped to a higher fee'
           FROM previous
         )
         SELECT * FROM updated`,
        [intentId, txHash, bumpedFromTxHash,
          gasPriceWei ? gasPriceWei.toString() : null,
          maxFeePerGasWei ? maxFeePerGasWei.toString() : null,
          maxPriorityFeePerGasWei ? maxPriorityFeePerGasWei.toString() : null],
      );
      if (!result.rowCount) throw new Error(`attachBump: intent ${intentId} is no longer pending`);
      return mapIntent(result.rows[0]);
    },

    async transition(intentId, toState, { reason = null, replacementTxHash = null, blockNumber = null,
      gasUsed=null,effectiveGasPriceWei=null,actualNetworkCostWei=null,tokenIds=null } = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query('SELECT state FROM transaction_intents WHERE intent_id=$1 FOR UPDATE', [intentId]);
        if (!current.rowCount) throw new Error('Transaction intent not found');
        const fromState = current.rows[0].state;
        // TX-023 (Model 2 phase-2): final states are monotonic — a stale reconciler must not
        // reopen a confirmed mint as pending, or change a reverted to confirmed. Same-state
        // transitions (e.g. pending→pending on a bump) are allowed; different final states
        // are also allowed (e.g. the bump ladder re-bids and the replacement confirms after
        // the original reverted — that's a legitimate state change, not a stale observation).
        const FINAL = new Set(['confirmed', 'reverted', 'replaced']);
        if (FINAL.has(fromState) && fromState !== toState) {
          await client.query('COMMIT');
          const unchanged = await client.query('SELECT * FROM transaction_intents WHERE intent_id=$1', [intentId]);
          return mapIntent(unchanged.rows[0]);
        }
        const result = await client.query(`UPDATE transaction_intents SET state=$2,
          failure_reason=$3,replacement_tx_hash=COALESCE($4,replacement_tx_hash),
          block_number=COALESCE($5,block_number),gas_used=COALESCE($6,gas_used),
          effective_gas_price_wei=COALESCE($7,effective_gas_price_wei),actual_network_cost_wei=COALESCE($8,actual_network_cost_wei),
          token_ids=COALESCE($9,token_ids),last_reconciled_at=NOW(),
          pending_at=CASE WHEN $2='pending' THEN COALESCE(pending_at,NOW()) ELSE pending_at END,
          finalized_at=CASE WHEN $2 IN ('confirmed','reverted','replaced') THEN NOW() ELSE finalized_at END
          WHERE intent_id=$1 RETURNING *`,
        [intentId, toState, reason, replacementTxHash, blockNumber,gasUsed?.toString()??null,
          effectiveGasPriceWei?.toString()??null,actualNetworkCostWei?.toString()??null,
          tokenIds&&tokenIds.length?tokenIds:null]);
        if (fromState !== toState || reason) {
          await client.query(`INSERT INTO transaction_state_transitions (intent_id,from_state,to_state,reason)
            VALUES ($1,$2,$3,$4)`, [intentId, fromState, toState, reason]);
        }
        await client.query('COMMIT');
        return mapIntent(result.rows[0]);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async get(intentId) {
      const result = await pool.query('SELECT * FROM transaction_intents WHERE intent_id=$1', [intentId]);
      return mapIntent(result.rows[0]);
    },

    async getByIdempotencyKey(idempotencyKey) {
      const result = await pool.query('SELECT * FROM transaction_intents WHERE idempotency_key=$1', [idempotencyKey]);
      return mapIntent(result.rows[0]);
    },

    // TX-021: append-only broadcast hash record. Called BEFORE any provider receives the signed
    // bytes, so restart reconciliation can find the hash even if the process dies between
    // signing and broadcast confirmation.
    async recordBroadcastHash(intentId, txHash) {
      await pool.query(
        `INSERT INTO transaction_broadcast_hashes (intent_id, tx_hash) VALUES ($1, $2)
         ON CONFLICT (intent_id, tx_hash) DO NOTHING`,
        [intentId, txHash],
      );
    },

    async getBroadcastHashes(intentId) {
      const result = await pool.query(
        `SELECT tx_hash FROM transaction_broadcast_hashes WHERE intent_id=$1 ORDER BY created_at`,
        [intentId],
      );
      return result.rows.map(row => row.tx_hash);
    },

    async listNonFinal() {
      const result = await pool.query(
        `SELECT * FROM transaction_intents WHERE state=ANY($1::TEXT[]) ORDER BY created_at`,
        [NON_FINAL_STATES],
      );
      return result.rows.map(mapIntent);
    },

    async listNonFinalForUser(userId,limit=20) {
      const result=await pool.query(`SELECT * FROM transaction_intents WHERE user_id=$1
        AND state=ANY($2::TEXT[]) ORDER BY created_at DESC LIMIT $3`,[userId,NON_FINAL_STATES,limit]);
      return result.rows.map(mapIntent);
    },

    async listPageForUser(userId,{limit,offset}) {
      const [rows,count]=await Promise.all([pool.query(`SELECT * FROM transaction_intents WHERE user_id=$1
        ORDER BY created_at DESC,intent_id DESC LIMIT $2 OFFSET $3`,[userId,limit,offset]),
      pool.query('SELECT COUNT(*)::INTEGER AS total FROM transaction_intents WHERE user_id=$1',[userId])]);
      return {items:rows.rows.map(mapIntent),total:count.rows[0].total};
    },

    async listMintPageForUser(userId,{limit,offset}) {
      const [rows,count]=await Promise.all([
        pool.query(`SELECT intent.*,wallet.label AS wallet_label
          FROM transaction_intents intent
          LEFT JOIN wallets wallet ON wallet.user_id=intent.user_id AND wallet.id=intent.wallet_id
          WHERE intent.user_id=$1 AND intent.method_signature IS NOT NULL
          ORDER BY intent.created_at DESC,intent.intent_id DESC LIMIT $2 OFFSET $3`,[userId,limit,offset]),
        pool.query(`SELECT COUNT(*)::INTEGER AS total FROM transaction_intents
          WHERE user_id=$1 AND method_signature IS NOT NULL`,[userId]),
      ]);
      return {items:rows.rows.map(mapIntent),total:count.rows[0].total};
    },

    async rollingSpendWei(userId, walletId, sinceMs) {
      // Budget accounting is STATE-AWARE (Model 2 phase-1/2, TX-005):
      //   confirmed -- actual network fee + mint value (the full cost; estimate only if the
      //                receipt somehow lacks cost fields) -- windowed by FINALIZED time, not
      //                creation, so a transaction created 25h ago but finalized now still counts
      //                (late-finalization), and exactly at the boundary is inclusive.
      //   reverted  -- actual network fee ONLY: gas was really paid, but no value transferred
      //                (also windowed by finalized_at; missing actual cost is 0, not estimate)
      //   unknown   -- full estimate: the broadcast may still be live, so its cost stays reserved
      //                even if created before the window (old-unknown) until it terminally resolves.
      //   submitted/pending -- full estimate (pre-receipt) -- also reserved while live.
      //   replaced  -- excluded by policy: the winning transaction at that nonce carries the
      //                economic outcome, and this row's unreceipted gas is not reservable budget.
      //                Its gas loss is still visible in reporting via the intent's own row.
      const result = await pool.query(`SELECT COALESCE(SUM(
          CASE state
            WHEN 'confirmed' THEN COALESCE(actual_network_cost_wei + value_wei, estimated_cost_wei)
            WHEN 'reverted' THEN COALESCE(actual_network_cost_wei, 0)
            ELSE estimated_cost_wei
          END
        ), 0) AS total
        FROM transaction_intents WHERE user_id=$1 AND wallet_id=$2
        AND state IN ('submitted','pending','confirmed','unknown','reverted')
        AND (
          -- Final states: windowed by when they settled, so late finalization counts
          (state IN ('confirmed','reverted') AND COALESCE(finalized_at, created_at) >= TO_TIMESTAMP($3 / 1000.0))
          OR
          -- Non-final states: reserved while live, regardless of age (old-unknown)
          -- Created within window always counts; even if created before window, if it has
          -- no finalized_at (still live) it must stay reserved until it resolves.
          (state IN ('submitted','pending','unknown') AND (
            created_at >= TO_TIMESTAMP($3 / 1000.0)
            OR finalized_at IS NULL
          ))
        )`, [userId, walletId, sinceMs]);
      return BigInt(result.rows[0].total);
    },
  };
}

module.exports = { NON_FINAL_STATES, createTransactionIntentRepository, mapIntent };
