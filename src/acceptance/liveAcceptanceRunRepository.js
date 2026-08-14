function mapRun(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    operatorUserId: row.operator_user_id,
    chain: row.chain,
    contractAddress: row.contract_address,
    walletId: Number(row.wallet_id),
    methodSignature: row.method_signature,
    intentId: row.intent_id,
    outcome: row.outcome,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    simulationPerformed: row.simulation_performed,
    policySnapshot: row.policy_snapshot,
    evidence: row.evidence,
    startedAt: new Date(row.started_at).getTime(),
    finishedAt: new Date(row.finished_at).getTime(),
  };
}

function createLiveAcceptanceRunRepository(pool) {
  return {
    async record(run) {
      const result = await pool.query(`INSERT INTO live_acceptance_runs
        (operator_user_id, chain, contract_address, wallet_id, method_signature, intent_id,
          outcome, failure_code, failure_reason, simulation_performed, policy_snapshot, evidence, started_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::JSONB,$12::JSONB,TO_TIMESTAMP($13 / 1000.0))
        RETURNING *`,
      [run.operatorUserId, run.chain, run.contractAddress, run.walletId, run.methodSignature,
        run.intentId || null, run.outcome, run.failureCode || null, run.failureReason || null,
        run.simulationPerformed, JSON.stringify(run.policySnapshot), JSON.stringify(run.evidence),
        run.startedAt]);
      return mapRun(result.rows[0]);
    },

    async listForOperator(operatorUserId, limit = 20) {
      const result = await pool.query(`SELECT * FROM live_acceptance_runs
        WHERE operator_user_id=$1 ORDER BY finished_at DESC LIMIT $2`, [operatorUserId, limit]);
      return result.rows.map(mapRun);
    },
  };
}

module.exports = { createLiveAcceptanceRunRepository, mapRun };
