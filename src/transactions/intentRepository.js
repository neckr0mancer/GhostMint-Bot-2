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
    simulationEnabled: row.simulation_enabled,
    requiredConfirmations: row.required_confirmations,
    transactionTimeoutMs: row.transaction_timeout_ms,
    state: row.state,
    txHash: row.tx_hash,
    replacementTxHash: row.replacement_tx_hash,
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    failureReason: row.failure_reason,
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
            state,timeout_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'submitted',
            TO_TIMESTAMP($18 / 1000.0)) RETURNING *`,
        [intent.userId, intent.walletId, intent.targetId, intent.chain, intent.from, intent.to,
          intent.data, intent.valueWei.toString(), intent.nonce, intent.gasLimit.toString(),
          intent.gasPriceWei?.toString() ?? null, intent.maxFeePerGasWei?.toString() ?? null,
          intent.maxPriorityFeePerGasWei?.toString() ?? null, intent.estimatedCostWei.toString(),
          intent.simulationEnabled, intent.requiredConfirmations, intent.transactionTimeoutMs,
          intent.timeoutAt]);
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

    async transition(intentId, toState, { reason = null, replacementTxHash = null, blockNumber = null } = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query('SELECT state FROM transaction_intents WHERE intent_id=$1 FOR UPDATE', [intentId]);
        if (!current.rowCount) throw new Error('Transaction intent not found');
        const fromState = current.rows[0].state;
        const result = await client.query(`UPDATE transaction_intents SET state=$2,
          failure_reason=$3,replacement_tx_hash=COALESCE($4,replacement_tx_hash),
          block_number=COALESCE($5,block_number),last_reconciled_at=NOW(),
          pending_at=CASE WHEN $2='pending' THEN COALESCE(pending_at,NOW()) ELSE pending_at END,
          finalized_at=CASE WHEN $2 IN ('confirmed','reverted','replaced') THEN NOW() ELSE finalized_at END
          WHERE intent_id=$1 RETURNING *`,
        [intentId, toState, reason, replacementTxHash, blockNumber]);
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

    async listNonFinal() {
      const result = await pool.query(
        `SELECT * FROM transaction_intents WHERE state=ANY($1::TEXT[]) ORDER BY created_at`,
        [NON_FINAL_STATES],
      );
      return result.rows.map(mapIntent);
    },

    async rollingSpendWei(userId, walletId, sinceMs) {
      const result = await pool.query(`SELECT COALESCE(SUM(estimated_cost_wei),0) AS total
        FROM transaction_intents WHERE user_id=$1 AND wallet_id=$2
        AND created_at >= TO_TIMESTAMP($3 / 1000.0)
        AND state IN ('submitted','pending','confirmed')`, [userId, walletId, sinceMs]);
      return BigInt(result.rows[0].total);
    },
  };
}

module.exports = { NON_FINAL_STATES, createTransactionIntentRepository, mapIntent };
