const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const TX_HASH = /^0x[0-9a-f]{64}$/;
const BLOCK_HASH = /^0x[0-9a-f]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

function normalizedText(value, field, pattern = null) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || (pattern && !pattern.test(normalized))) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function nullableDecimal(value, field, maximum = UINT256_MAX) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) throw new TypeError(`${field} must be an unsigned decimal string`);
  if (BigInt(normalized) > maximum) throw new TypeError(`${field} exceeds its storage range`);
  return normalized;
}

function dateValue(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${field} must be a valid date`);
  return date;
}

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function walletIdNumber(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('walletId exceeds the safe API range');
  return id;
}

function decimalOrNull(value) {
  return value === null || value === undefined ? null : String(value);
}

function timeOrNull(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function mapMovement(row) {
  return {
    eventLocator: row.event_locator,
    eventType: row.event_type,
    direction: row.direction,
    assetStandard: row.asset_standard,
    assetAddress: row.asset_address,
    tokenId: decimalOrNull(row.token_id),
    amountRaw: decimalOrNull(row.amount_raw),
    fromAddress: row.from_address,
    toAddress: row.to_address,
    details: row.details ?? null,
  };
}

function mapTransaction(row) {
  const movements = Array.isArray(row.movements) ? row.movements : [];
  return {
    chain: row.chain,
    walletAddress: row.wallet_address,
    txHash: row.tx_hash,
    blockNumber: String(row.block_number),
    blockHash: row.block_hash,
    transactionIndex: numberOrNull(row.transaction_index),
    occurredAt: timeOrNull(row.occurred_at),
    fromAddress: row.from_address,
    toAddress: row.to_address,
    nonce: decimalOrNull(row.nonce),
    input: row.input,
    methodSelector: row.method_selector,
    valueWei: String(row.value_wei ?? '0'),
    gasLimit: decimalOrNull(row.gas_limit),
    gasUsed: decimalOrNull(row.gas_used),
    effectiveGasPriceWei: decimalOrNull(row.effective_gas_price_wei),
    networkFeeWei: decimalOrNull(row.network_fee_wei),
    executionStatus: row.execution_status,
    finalityStatus: row.finality_status,
    canonical: row.canonical,
    source: row.source,
    providerKey: row.provider_key,
    providerComplete: row.provider_complete,
    firstObservedAt: timeOrNull(row.first_observed_at),
    lastObservedAt: timeOrNull(row.last_observed_at),
    movements: movements.map(mapMovement),
  };
}

function mapAccountTransaction(row) {
  return {
    ...mapTransaction(row),
    walletId: walletIdNumber(row.wallet_id),
    walletLabel: row.wallet_label ?? null,
  };
}

function mapSubject(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    chain: row.chain,
    walletAddress: row.wallet_address,
    trackingStartedAt: timeOrNull(row.tracking_started_at),
    trackingStartBlock: decimalOrNull(row.tracking_start_block),
    lastImportedAt: timeOrNull(row.last_imported_at),
    syncEnabled: row.sync_enabled,
    lastRemovedAt: timeOrNull(row.last_removed_at),
  };
}

function mapSyncState(row) {
  if (!row || row.state === null || row.state === undefined) return null;
  return {
    providerKey: row.provider_key,
    state: row.state,
    cursor: row.cursor ?? null,
    generation: Number(row.generation || 0),
    historyCompleteFromBlock: decimalOrNull(row.history_complete_from_block),
    historyCompleteThroughBlock: decimalOrNull(row.history_complete_through_block),
    provenanceCompleteFromBlock: decimalOrNull(row.provenance_complete_from_block),
    provenanceCompleteThroughBlock: decimalOrNull(row.provenance_complete_through_block),
    finalizedThroughBlock: decimalOrNull(row.finalized_through_block),
    attempts: Number(row.attempts || 0),
    lastRequestedAt: timeOrNull(row.last_requested_at),
    lastStartedAt: timeOrNull(row.last_started_at),
    lastSucceededAt: timeOrNull(row.last_succeeded_at),
    lastErrorAt: timeOrNull(row.last_error_at),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    retryAfter: timeOrNull(row.retry_after),
    claimedBy: row.claimed_by ?? null,
    claimedAt: timeOrNull(row.claimed_at),
    leaseExpiresAt: timeOrNull(row.lease_expires_at),
  };
}

function mapClaim(row) {
  if (!row) return null;
  return {
    userId:String(row.user_id),
    chain:row.chain,
    walletAddress:row.wallet_address,
    ...mapSyncState(row),
  };
}

function createWalletHistoryRepository(pool) {
  function subjectKey(input) {
    return {
      userId: String(input.userId),
      chain: normalizedText(input.chain, 'chain'),
      walletAddress: normalizedText(input.walletAddress, 'walletAddress', EVM_ADDRESS),
    };
  }

  async function registerSubject(input) {
    const key = subjectKey(input);
    const trackingStartBlock = nullableDecimal(input.trackingStartBlock, 'trackingStartBlock', PG_BIGINT_MAX);
    const result = await pool.query(`INSERT INTO wallet_history_subjects
      (user_id,chain,wallet_address,tracking_start_block)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id,chain,wallet_address) DO UPDATE SET
        tracking_start_block=COALESCE(wallet_history_subjects.tracking_start_block,
          EXCLUDED.tracking_start_block),
        last_imported_at=NOW(),sync_enabled=TRUE,last_removed_at=NULL,updated_at=NOW()
      RETURNING *`, [key.userId, key.chain, key.walletAddress, trackingStartBlock]);
    return mapSubject(result.rows[0]);
  }

  async function getSubject(input) {
    const key = subjectKey(input);
    const result = await pool.query(`SELECT subject.*,sync.provider_key,sync.state,sync.cursor,
        sync.generation,sync.history_complete_from_block,sync.history_complete_through_block,
        sync.provenance_complete_from_block,sync.provenance_complete_through_block,
        sync.finalized_through_block,sync.attempts,sync.last_requested_at,sync.last_started_at,
        sync.last_succeeded_at,sync.last_error_at,sync.last_error_code,sync.last_error_message,
        sync.retry_after,sync.claimed_by,sync.claimed_at,sync.lease_expires_at
      FROM wallet_history_subjects subject
      LEFT JOIN wallet_history_sync_state sync USING (user_id,chain,wallet_address)
      WHERE subject.user_id=$1 AND subject.chain=$2 AND subject.wallet_address=$3`,
    [key.userId, key.chain, key.walletAddress]);
    if (!result.rowCount) return null;
    return { ...mapSubject(result.rows[0]), sync: mapSyncState(result.rows[0]) };
  }

  async function listSubjects(userId, walletAddress) {
    const address = normalizedText(walletAddress, 'walletAddress', EVM_ADDRESS);
    const result = await pool.query(`SELECT subject.*,sync.provider_key,sync.state,sync.cursor,
        sync.generation,sync.history_complete_from_block,sync.history_complete_through_block,
        sync.provenance_complete_from_block,sync.provenance_complete_through_block,
        sync.finalized_through_block,sync.attempts,sync.last_requested_at,sync.last_started_at,
        sync.last_succeeded_at,sync.last_error_at,sync.last_error_code,sync.last_error_message,
        sync.retry_after,sync.claimed_by,sync.claimed_at,sync.lease_expires_at
      FROM wallet_history_subjects subject
      LEFT JOIN wallet_history_sync_state sync USING (user_id,chain,wallet_address)
      WHERE subject.user_id=$1 AND subject.wallet_address=$2
      ORDER BY subject.chain`, [String(userId), address]);
    return result.rows.map(row => ({ ...mapSubject(row), sync:mapSyncState(row) }));
  }

  async function deleteSubject(input) {
    const key = subjectKey(input);
    const result = await pool.query(`DELETE FROM wallet_history_subjects
      WHERE user_id=$1 AND chain=$2 AND wallet_address=$3`,
    [key.userId, key.chain, key.walletAddress]);
    return result.rowCount > 0;
  }

  async function setSyncState(input) {
    const key = subjectKey(input);
    const providerKey = input.providerKey === null || input.providerKey === undefined
      ? null : normalizedText(input.providerKey, 'providerKey');
    const allowed = new Set(['queued', 'backfilling', 'current', 'partial', 'unsupported', 'error']);
    const state = normalizedText(input.state, 'state');
    if (!allowed.has(state)) throw new TypeError('state is invalid');
    const result = await pool.query(`INSERT INTO wallet_history_sync_state
      (user_id,chain,wallet_address,provider_key,state,last_requested_at,last_error_at,
        last_error_code,last_error_message,retry_after)
      VALUES ($1,$2,$3,$4,$5,NOW(),CASE WHEN $5='error' THEN NOW() ELSE NULL END,$6,$7,$8)
      ON CONFLICT (user_id,chain,wallet_address) DO UPDATE SET
        provider_key=EXCLUDED.provider_key,state=EXCLUDED.state,last_requested_at=NOW(),
        last_error_at=EXCLUDED.last_error_at,last_error_code=EXCLUDED.last_error_code,
        last_error_message=EXCLUDED.last_error_message,retry_after=EXCLUDED.retry_after,
        claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL,
        updated_at=NOW()
      RETURNING *`, [key.userId, key.chain, key.walletAddress, providerKey, state,
      input.errorCode ?? null, input.errorMessage ?? null,
      input.retryAfter ? dateValue(input.retryAfter, 'retryAfter') : null]);
    return mapSyncState(result.rows[0]);
  }

  // Queueing is deliberately separate from setSyncState(). A user can press refresh while a
  // worker owns this row; resetting the state and lease in that moment would make the in-flight
  // page stale and could multiply provider work. This upsert refreshes an existing request while
  // preserving queued/backfill progress and any live worker lease, including retryable errors.
  async function queueSync(input) {
    const key = subjectKey(input);
    const providerKey = normalizedText(input.providerKey, 'providerKey');
    const result = await pool.query(`INSERT INTO wallet_history_sync_state
      (user_id,chain,wallet_address,provider_key,state,last_requested_at)
      VALUES ($1,$2,$3,$4,'queued',NOW())
      ON CONFLICT (user_id,chain,wallet_address) DO UPDATE SET
        provider_key=CASE WHEN wallet_history_sync_state.state IN ('queued','backfilling')
            OR (wallet_history_sync_state.claimed_by IS NOT NULL
              AND wallet_history_sync_state.lease_expires_at>NOW())
          THEN wallet_history_sync_state.provider_key ELSE EXCLUDED.provider_key END,
        state=CASE WHEN wallet_history_sync_state.state IN ('queued','backfilling')
            OR (wallet_history_sync_state.claimed_by IS NOT NULL
              AND wallet_history_sync_state.lease_expires_at>NOW())
          THEN wallet_history_sync_state.state ELSE 'queued' END,
        cursor=CASE WHEN wallet_history_sync_state.state IN ('queued','backfilling')
            OR (wallet_history_sync_state.claimed_by IS NOT NULL
              AND wallet_history_sync_state.lease_expires_at>NOW())
          THEN wallet_history_sync_state.cursor ELSE NULL END,
        last_requested_at=NOW(),
        last_error_at=CASE WHEN wallet_history_sync_state.state IN ('queued','backfilling')
            OR (wallet_history_sync_state.claimed_by IS NOT NULL
              AND wallet_history_sync_state.lease_expires_at>NOW())
          THEN wallet_history_sync_state.last_error_at ELSE NULL END,
        last_error_code=CASE WHEN wallet_history_sync_state.state IN ('queued','backfilling')
            OR (wallet_history_sync_state.claimed_by IS NOT NULL
              AND wallet_history_sync_state.lease_expires_at>NOW())
          THEN wallet_history_sync_state.last_error_code ELSE NULL END,
        last_error_message=CASE WHEN wallet_history_sync_state.state IN ('queued','backfilling')
            OR (wallet_history_sync_state.claimed_by IS NOT NULL
              AND wallet_history_sync_state.lease_expires_at>NOW())
          THEN wallet_history_sync_state.last_error_message ELSE NULL END,
        retry_after=CASE WHEN wallet_history_sync_state.state IN ('queued','backfilling')
            OR (wallet_history_sync_state.claimed_by IS NOT NULL
              AND wallet_history_sync_state.lease_expires_at>NOW())
          THEN wallet_history_sync_state.retry_after ELSE NULL END,
        claimed_by=CASE WHEN wallet_history_sync_state.claimed_by IS NOT NULL
            AND wallet_history_sync_state.lease_expires_at>NOW()
          THEN wallet_history_sync_state.claimed_by ELSE NULL END,
        claimed_at=CASE WHEN wallet_history_sync_state.claimed_by IS NOT NULL
            AND wallet_history_sync_state.lease_expires_at>NOW()
          THEN wallet_history_sync_state.claimed_at ELSE NULL END,
        lease_expires_at=CASE WHEN wallet_history_sync_state.claimed_by IS NOT NULL
            AND wallet_history_sync_state.lease_expires_at>NOW()
          THEN wallet_history_sync_state.lease_expires_at ELSE NULL END,
        updated_at=NOW()
      RETURNING *`, [key.userId, key.chain, key.walletAddress, providerKey]);
    return mapSyncState(result.rows[0]);
  }

  async function beginSync(input) {
    const key = subjectKey(input);
    const providerKey = normalizedText(input.providerKey, 'providerKey');
    const result = await pool.query(`INSERT INTO wallet_history_sync_state
      (user_id,chain,wallet_address,provider_key,state,generation,attempts,last_requested_at,last_started_at)
      VALUES ($1,$2,$3,$4,'backfilling',1,1,NOW(),NOW())
      ON CONFLICT (user_id,chain,wallet_address) DO UPDATE SET
        provider_key=EXCLUDED.provider_key,state='backfilling',
        generation=wallet_history_sync_state.generation+1,
        cursor=NULL,
        attempts=wallet_history_sync_state.attempts+1,last_requested_at=NOW(),last_started_at=NOW(),
        last_error_at=NULL,last_error_code=NULL,last_error_message=NULL,retry_after=NULL,
        claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=NOW()
      RETURNING *`, [key.userId, key.chain, key.walletAddress, providerKey]);
    return mapSyncState(result.rows[0]);
  }

  async function claimDue(input = {}) {
    const workerId = normalizedText(input.workerId, 'workerId');
    const now = Number(input.now);
    const leaseMs = Number(input.leaseMs);
    if (!Number.isFinite(now) || now < 0) throw new TypeError('now is invalid');
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) {
      throw new TypeError('leaseMs must be between 1000 and 600000');
    }
    const result = await pool.query(`WITH candidate AS (
        SELECT sync.user_id,sync.chain,sync.wallet_address
        FROM wallet_history_sync_state sync
        JOIN wallet_history_subjects subject USING (user_id,chain,wallet_address)
        WHERE subject.sync_enabled=TRUE AND sync.provider_key IS NOT NULL
          AND (sync.state IN ('queued','backfilling')
            OR (sync.state='error' AND sync.retry_after IS NOT NULL
              AND sync.retry_after<=TO_TIMESTAMP($2 / 1000.0)))
          AND (sync.claimed_by IS NULL OR sync.lease_expires_at<=TO_TIMESTAMP($2 / 1000.0))
        ORDER BY CASE sync.state WHEN 'queued' THEN 0 WHEN 'backfilling' THEN 1 ELSE 2 END,
          sync.last_requested_at NULLS FIRST,sync.updated_at
        FOR UPDATE OF sync SKIP LOCKED LIMIT 1
      ) UPDATE wallet_history_sync_state sync SET
        state=CASE WHEN sync.state='queued' THEN 'backfilling' ELSE sync.state END,
        cursor=CASE WHEN sync.state='queued' THEN NULL ELSE sync.cursor END,
        generation=CASE WHEN sync.state='queued' THEN sync.generation+1 ELSE sync.generation END,
        attempts=sync.attempts+1,last_started_at=TO_TIMESTAMP($2 / 1000.0),
        claimed_by=$1,claimed_at=TO_TIMESTAMP($2 / 1000.0),
        lease_expires_at=TO_TIMESTAMP(($2+$3) / 1000.0),updated_at=NOW()
      FROM candidate
      WHERE sync.user_id=candidate.user_id AND sync.chain=candidate.chain
        AND sync.wallet_address=candidate.wallet_address
      RETURNING sync.*`, [workerId, now, leaseMs]);
    return result.rowCount ? mapClaim(result.rows[0]) : null;
  }

  async function releaseClaim(input) {
    const key = subjectKey(input);
    const workerId = normalizedText(input.workerId, 'workerId');
    const result = await pool.query(`UPDATE wallet_history_sync_state SET
        claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=NOW()
      WHERE user_id=$1 AND chain=$2 AND wallet_address=$3 AND claimed_by=$4
      RETURNING *`, [key.userId,key.chain,key.walletAddress,workerId]);
    return result.rowCount ? mapSyncState(result.rows[0]) : null;
  }

  async function applyProviderPage(input) {
    const key = subjectKey(input);
    const providerKey = normalizedText(input.providerKey, 'providerKey');
    const generation = Number(input.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('generation is invalid');
    const page = input.page || {};
    const transactions = Array.isArray(page.transactions) ? page.transactions : [];
    const expectedCursor = input.expectedCursor === null || input.expectedCursor === undefined
      ? null : JSON.stringify(input.expectedCursor);
    const workerId = input.workerId === null || input.workerId === undefined
      ? null : normalizedText(input.workerId, 'workerId');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const subject = await client.query(`SELECT 1 FROM wallet_history_subjects
        WHERE user_id=$1 AND chain=$2 AND wallet_address=$3 FOR UPDATE`,
      [key.userId, key.chain, key.walletAddress]);
      if (!subject.rowCount) throw new Error('Wallet history subject not found');
      const claimed = await client.query(`SELECT 1 FROM wallet_history_sync_state
        WHERE user_id=$1 AND chain=$2 AND wallet_address=$3 AND provider_key=$4
          AND generation=$5 AND cursor IS NOT DISTINCT FROM $6::JSONB
          AND state IN ('backfilling','error')
          AND (($7::TEXT IS NULL AND claimed_by IS NULL)
            OR ($7::TEXT IS NOT NULL AND claimed_by=$7 AND lease_expires_at>NOW()))
        FOR UPDATE`, [key.userId, key.chain, key.walletAddress, providerKey, generation,
        expectedCursor,workerId]);
      if (!claimed.rowCount) {
        const error = new Error('Wallet history sync generation or cursor is stale');
        error.code = 'WALLET_HISTORY_SYNC_STALE';
        throw error;
      }
      if (page.observedHeadBlock !== null && page.observedHeadBlock !== undefined) {
        await client.query(`UPDATE wallet_history_subjects SET
            tracking_start_block=COALESCE(tracking_start_block,$4),updated_at=NOW()
          WHERE user_id=$1 AND chain=$2 AND wallet_address=$3`,
        [key.userId, key.chain, key.walletAddress,
          nullableDecimal(page.observedHeadBlock, 'observedHeadBlock', PG_BIGINT_MAX)]);
      }
      for (const transaction of transactions) {
        const txHash = normalizedText(transaction.txHash, 'txHash', TX_HASH);
        const blockNumber = nullableDecimal(transaction.blockNumber, 'blockNumber', PG_BIGINT_MAX);
        if (blockNumber === null) throw new TypeError('blockNumber is required');
        const blockHash = transaction.blockHash === null || transaction.blockHash === undefined
          ? null : normalizedText(transaction.blockHash, 'blockHash', BLOCK_HASH);
        const fromAddress = normalizedText(transaction.fromAddress, 'fromAddress', EVM_ADDRESS);
        const toAddress = transaction.toAddress === null || transaction.toAddress === undefined
          ? null : normalizedText(transaction.toAddress, 'toAddress', EVM_ADDRESS);
        const transactionIndex = transaction.transactionIndex === null
          || transaction.transactionIndex === undefined ? null : Number(transaction.transactionIndex);
        if (transactionIndex !== null && (!Number.isSafeInteger(transactionIndex)
          || transactionIndex < 0 || transactionIndex > 2_147_483_647)) {
          throw new TypeError('transactionIndex is invalid');
        }
        const inserted = await client.query(`INSERT INTO wallet_history_transactions
          (user_id,chain,wallet_address,tx_hash,block_number,block_hash,transaction_index,
            occurred_at,from_address,to_address,nonce,input,method_selector,value_wei,gas_limit,
            gas_used,effective_gas_price_wei,network_fee_wei,execution_status,finality_status,
            canonical,orphaned_at,provider_key,provider_complete,generation,raw_summary)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
            $21,CASE WHEN $21 THEN NULL ELSE NOW() END,$22,$23,$24,$25::JSONB)
          ON CONFLICT (user_id,chain,wallet_address,tx_hash) DO UPDATE SET
            block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,
            transaction_index=EXCLUDED.transaction_index,occurred_at=EXCLUDED.occurred_at,
            from_address=EXCLUDED.from_address,to_address=EXCLUDED.to_address,nonce=EXCLUDED.nonce,
            input=EXCLUDED.input,method_selector=EXCLUDED.method_selector,value_wei=EXCLUDED.value_wei,
            gas_limit=EXCLUDED.gas_limit,gas_used=EXCLUDED.gas_used,
            effective_gas_price_wei=EXCLUDED.effective_gas_price_wei,
            network_fee_wei=EXCLUDED.network_fee_wei,execution_status=EXCLUDED.execution_status,
            finality_status=EXCLUDED.finality_status,canonical=EXCLUDED.canonical,
            orphaned_at=EXCLUDED.orphaned_at,
            provider_key=EXCLUDED.provider_key,provider_complete=EXCLUDED.provider_complete,
            generation=EXCLUDED.generation,raw_summary=EXCLUDED.raw_summary,last_observed_at=NOW()
          RETURNING tx_hash`, [key.userId, key.chain, key.walletAddress, txHash, blockNumber,
          blockHash, transactionIndex, dateValue(transaction.occurredAt, 'occurredAt'),
          fromAddress, toAddress, nullableDecimal(transaction.nonce, 'nonce'), transaction.input ?? null,
          transaction.methodSelector ? normalizedText(transaction.methodSelector, 'methodSelector') : null,
          nullableDecimal(transaction.valueWei ?? '0', 'valueWei'),
          nullableDecimal(transaction.gasLimit, 'gasLimit'), nullableDecimal(transaction.gasUsed, 'gasUsed'),
          nullableDecimal(transaction.effectiveGasPriceWei, 'effectiveGasPriceWei'),
          nullableDecimal(transaction.networkFeeWei, 'networkFeeWei'), transaction.executionStatus || 'unknown',
          transaction.finalityStatus || 'unfinalized', transaction.canonical !== false, providerKey,
          page.coverage?.history?.complete === true, generation,
          transaction.rawSummary === undefined ? null : JSON.stringify(transaction.rawSummary)]);
        if (!inserted.rowCount) throw new Error('Wallet history transaction was not stored');
        await client.query(`DELETE FROM wallet_history_movements
          WHERE user_id=$1 AND chain=$2 AND wallet_address=$3 AND tx_hash=$4`,
        [key.userId, key.chain, key.walletAddress, txHash]);
        for (const movement of transaction.movements || []) {
          await client.query(`INSERT INTO wallet_history_movements
            (user_id,chain,wallet_address,tx_hash,event_locator,event_type,direction,asset_standard,
              asset_address,token_id,amount_raw,from_address,to_address,details)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::JSONB)`,
          [key.userId, key.chain, key.walletAddress, txHash, String(movement.eventLocator),
            String(movement.eventType), movement.direction || 'unknown', movement.assetStandard || 'unknown',
            movement.assetAddress ? normalizedText(movement.assetAddress, 'assetAddress', EVM_ADDRESS) : null,
            nullableDecimal(movement.tokenId, 'tokenId'), nullableDecimal(movement.amountRaw, 'amountRaw'),
            movement.fromAddress ? normalizedText(movement.fromAddress, 'movement.fromAddress', EVM_ADDRESS) : null,
            movement.toAddress ? normalizedText(movement.toAddress, 'movement.toAddress', EVM_ADDRESS) : null,
            movement.details === undefined ? null : JSON.stringify(movement.details)]);
        }
      }
      const historyCoverage = page.coverage?.history?.complete === true ? page.coverage.history : null;
      const provenanceCoverage = page.coverage?.provenance?.complete === true
        ? page.coverage.provenance : null;
      if (page.hasMore === false && historyCoverage) {
        await client.query(`UPDATE wallet_history_transactions SET
            provider_complete=TRUE,last_observed_at=NOW()
          WHERE user_id=$1 AND chain=$2 AND wallet_address=$3 AND provider_key=$4
            AND generation=$5 AND canonical=TRUE`,
        [key.userId, key.chain, key.walletAddress, providerKey, generation]);
      }
      if (page.hasMore === false && historyCoverage && page.recheckRange) {
        const recheckFrom = nullableDecimal(page.recheckRange.fromBlock, 'recheckRange.fromBlock',
          PG_BIGINT_MAX);
        const recheckThrough = nullableDecimal(page.recheckRange.throughBlock,
          'recheckRange.throughBlock', PG_BIGINT_MAX);
        if (recheckFrom === null || recheckThrough === null
          || BigInt(recheckFrom) < BigInt(historyCoverage.fromBlock)
          || BigInt(recheckThrough) > BigInt(historyCoverage.throughBlock)) {
          throw new TypeError('recheckRange must be contained within complete history coverage');
        }
        await client.query(`UPDATE wallet_history_transactions SET
            canonical=FALSE,orphaned_at=NOW(),last_observed_at=NOW()
          WHERE user_id=$1 AND chain=$2 AND wallet_address=$3
            AND block_number BETWEEN $4 AND $5 AND generation<>$6 AND canonical=TRUE`,
        [key.userId, key.chain, key.walletAddress, recheckFrom, recheckThrough, generation]);
      }
      const result = await client.query(`UPDATE wallet_history_sync_state SET
          cursor=$5::JSONB,state=$6,
          history_complete_from_block=COALESCE($7,history_complete_from_block),
          history_complete_through_block=COALESCE($8,history_complete_through_block),
          provenance_complete_from_block=COALESCE($9,provenance_complete_from_block),
          provenance_complete_through_block=COALESCE($10,provenance_complete_through_block),
          finalized_through_block=COALESCE($11,finalized_through_block),
          last_succeeded_at=NOW(),last_error_at=NULL,last_error_code=NULL,last_error_message=NULL,
          retry_after=NULL,claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=NOW()
        WHERE user_id=$1 AND chain=$2 AND wallet_address=$3 AND generation=$4 RETURNING *`,
      [key.userId, key.chain, key.walletAddress, generation,
        page.nextCursor === undefined ? null : JSON.stringify(page.nextCursor),
        page.hasMore === true ? 'backfilling' : (historyCoverage ? 'current' : 'partial'),
        nullableDecimal(historyCoverage?.fromBlock, 'coverage.history.fromBlock', PG_BIGINT_MAX),
        nullableDecimal(historyCoverage?.throughBlock, 'coverage.history.throughBlock', PG_BIGINT_MAX),
        nullableDecimal(provenanceCoverage?.fromBlock, 'coverage.provenance.fromBlock', PG_BIGINT_MAX),
        nullableDecimal(provenanceCoverage?.throughBlock, 'coverage.provenance.throughBlock', PG_BIGINT_MAX),
        null]);
      if (!result.rowCount) throw new Error('Wallet history sync generation is stale');
      await client.query('COMMIT');
      return mapSyncState(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function markSyncError(input) {
    const key = subjectKey(input);
    const providerKey = normalizedText(input.providerKey, 'providerKey');
    const generation = Number(input.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('generation is invalid');
    const expectedCursor = input.expectedCursor === null || input.expectedCursor === undefined
      ? null : JSON.stringify(input.expectedCursor);
    const workerId = input.workerId === null || input.workerId === undefined
      ? null : normalizedText(input.workerId, 'workerId');
    const result = await pool.query(`UPDATE wallet_history_sync_state SET
        state='error',last_error_at=NOW(),last_error_code=$7,last_error_message=$8,
        retry_after=$9,claimed_by=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=NOW()
      WHERE user_id=$1 AND chain=$2 AND wallet_address=$3 AND provider_key=$4
        AND generation=$5 AND cursor IS NOT DISTINCT FROM $6::JSONB
        AND (($10::TEXT IS NULL AND claimed_by IS NULL)
          OR ($10::TEXT IS NOT NULL AND claimed_by=$10 AND lease_expires_at>NOW()))
      RETURNING *`, [key.userId, key.chain, key.walletAddress, providerKey, generation,
      expectedCursor, input.errorCode ?? 'PROVIDER_SYNC_FAILED', input.errorMessage ?? null,
      input.retryAfter ? dateValue(input.retryAfter, 'retryAfter') : null,workerId]);
    return result.rowCount ? mapSyncState(result.rows[0]) : null;
  }

  async function listPage(userId, input) {
    const chain = input.chain ? normalizedText(input.chain, 'chain') : null;
    const walletAddress = normalizedText(input.walletAddress, 'walletAddress', EVM_ADDRESS);
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
    const offset = Math.max(0, Number(input.offset) || 0);
    const snapshotAt = input.snapshotAt ? dateValue(input.snapshotAt, 'snapshotAt') : new Date();
    const source = input.source ? normalizedText(input.source, 'source') : null;
    if (source && !['ghostmint', 'external', 'source_unknown'].includes(source)) {
      throw new TypeError('source is invalid');
    }
    const values = [String(userId), chain, walletAddress, snapshotAt, input.status || null,
      input.type || null, input.direction || null, input.address ? String(input.address).toLowerCase() : null,
      input.txHash ? String(input.txHash).toLowerCase() : null, source, limit, offset];
    const result = await pool.query(`WITH classified AS (
        SELECT tx.*,subject.tracking_start_block,
          sync.provenance_complete_from_block,sync.provenance_complete_through_block,
          CASE WHEN EXISTS (
            SELECT 1 FROM transaction_intents intent
            LEFT JOIN transaction_broadcast_hashes broadcast ON broadcast.intent_id=intent.intent_id
            WHERE intent.user_id=tx.user_id AND intent.chain=tx.chain
              AND LOWER(intent.from_address)=tx.wallet_address
              AND (LOWER(intent.tx_hash)=tx.tx_hash
                OR LOWER(intent.replacement_tx_hash)=tx.tx_hash
                OR LOWER(intent.bumped_from_tx_hash)=tx.tx_hash
                OR LOWER(broadcast.tx_hash)=tx.tx_hash)
          ) THEN 'ghostmint'
          WHEN subject.tracking_start_block IS NOT NULL
            AND tx.block_number > subject.tracking_start_block
            AND sync.provenance_complete_from_block IS NOT NULL
            AND sync.provenance_complete_through_block IS NOT NULL
            AND tx.block_number BETWEEN sync.provenance_complete_from_block
              AND sync.provenance_complete_through_block
          THEN 'external'
          ELSE 'source_unknown' END AS source
        FROM wallet_history_transactions tx
        JOIN wallet_history_subjects subject USING (user_id,chain,wallet_address)
        LEFT JOIN wallet_history_sync_state sync USING (user_id,chain,wallet_address)
        WHERE tx.user_id=$1 AND ($2::TEXT IS NULL OR tx.chain=$2) AND tx.wallet_address=$3
          AND tx.first_observed_at <= $4 AND tx.canonical=TRUE
      ), filtered AS (
        SELECT classified.* FROM classified
        WHERE ($5::TEXT IS NULL OR classified.execution_status=$5)
          AND ($6::TEXT IS NULL OR EXISTS (SELECT 1 FROM wallet_history_movements movement
            WHERE movement.user_id=classified.user_id AND movement.chain=classified.chain
              AND movement.wallet_address=classified.wallet_address AND movement.tx_hash=classified.tx_hash
              AND (movement.event_type=$6 OR movement.asset_standard=$6)))
          AND ($7::TEXT IS NULL OR EXISTS (SELECT 1 FROM wallet_history_movements movement
            WHERE movement.user_id=classified.user_id AND movement.chain=classified.chain
              AND movement.wallet_address=classified.wallet_address AND movement.tx_hash=classified.tx_hash
              AND movement.direction=$7))
          AND ($8::TEXT IS NULL OR classified.from_address=$8 OR classified.to_address=$8
            OR EXISTS (SELECT 1 FROM wallet_history_movements movement
              WHERE movement.user_id=classified.user_id AND movement.chain=classified.chain
                AND movement.wallet_address=classified.wallet_address AND movement.tx_hash=classified.tx_hash
                AND (movement.asset_address=$8 OR movement.from_address=$8 OR movement.to_address=$8)))
          AND ($9::TEXT IS NULL OR classified.tx_hash LIKE $9 || '%')
          AND ($10::TEXT IS NULL OR classified.source=$10)
      ), paged AS (
        SELECT filtered.*,
          COALESCE((SELECT JSONB_AGG(TO_JSONB(movement) - 'user_id' - 'chain' - 'wallet_address' - 'tx_hash'
            ORDER BY movement.event_locator)
            FROM wallet_history_movements movement
            WHERE movement.user_id=filtered.user_id AND movement.chain=filtered.chain
              AND movement.wallet_address=filtered.wallet_address AND movement.tx_hash=filtered.tx_hash),'[]'::JSONB)
            AS movements
        FROM filtered
        ORDER BY occurred_at DESC,chain,block_number DESC,transaction_index DESC NULLS LAST,tx_hash DESC
        LIMIT $11 OFFSET $12
      )
      SELECT paged.*,totals.result_total
      FROM (SELECT COUNT(*)::BIGINT AS result_total FROM filtered) totals
      LEFT JOIN paged ON TRUE
      ORDER BY paged.occurred_at DESC,paged.chain,paged.block_number DESC,
        paged.transaction_index DESC NULLS LAST,paged.tx_hash DESC`, values);
    const subjects = chain ? [await getSubject({ userId, chain, walletAddress })].filter(Boolean)
      : await listSubjects(userId, walletAddress);
    const chainCoverage = subjects.map(subject => ({
      chain:subject.chain,
      state:subject.sync?.state || 'not_started',
      historyFromBlock:subject.sync?.historyCompleteFromBlock ?? null,
      historyThroughBlock:subject.sync?.historyCompleteThroughBlock ?? null,
      provenanceFromBlock:subject.sync?.provenanceCompleteFromBlock ?? null,
      provenanceThroughBlock:subject.sync?.provenanceCompleteThroughBlock ?? null,
      finalizedThroughBlock:subject.sync?.finalizedThroughBlock ?? null,
    }));
    const coverageState = chainCoverage.length === 0 ? 'not_started'
      : chainCoverage.every(item => item.state === chainCoverage[0].state)
        ? chainCoverage[0].state : 'mixed';
    return {
      items: result.rows.filter(row => row.tx_hash).map(mapTransaction),
      total: result.rowCount ? Number(result.rows[0].result_total) : 0,
      snapshotAt: snapshotAt.toISOString(),
      snapshotScope: 'first_observed_at',
      coverage: { state:coverageState, chains:chainCoverage },
    };
  }

  async function listAccountPage(userId, input = {}) {
    const chain = input.chain ? normalizedText(input.chain, 'chain') : null;
    const walletId = input.walletId === null || input.walletId === undefined || input.walletId === ''
      ? null : Number(input.walletId);
    if (walletId !== null && (!Number.isSafeInteger(walletId) || walletId < 1)) {
      throw new TypeError('walletId is invalid');
    }
    const supportedChains = [...new Set((Array.isArray(input.supportedChains)
      ? input.supportedChains : []).map(value => normalizedText(value, 'supportedChains')))].sort();
    const coverageChains = chain ? [chain] : supportedChains;
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
    const offset = Math.max(0, Number(input.offset) || 0);
    const snapshotAt = input.snapshotAt ? dateValue(input.snapshotAt, 'snapshotAt') : new Date();
    const source = input.source ? normalizedText(input.source, 'source') : null;
    if (source && !['ghostmint', 'external', 'source_unknown'].includes(source)) {
      throw new TypeError('source is invalid');
    }
    const values = [String(userId), walletId, chain, snapshotAt, input.status || null,
      input.type || null, input.direction || null,
      input.address ? String(input.address).toLowerCase() : null,
      input.txHash ? String(input.txHash).toLowerCase() : null, source, limit, offset];
    const result = await pool.query(`WITH owned_wallets AS (
        SELECT DISTINCT ON (LOWER(address)) id,label,LOWER(address) AS wallet_address
        FROM wallets
        WHERE user_id=$1 AND ($2::BIGINT IS NULL OR id=$2)
        ORDER BY LOWER(address),id
      ), classified AS (
        SELECT tx.*,wallet.id AS wallet_id,wallet.label AS wallet_label,
          subject.tracking_start_block,
          sync.provenance_complete_from_block,sync.provenance_complete_through_block,
          CASE WHEN EXISTS (
            SELECT 1 FROM transaction_intents intent
            LEFT JOIN transaction_broadcast_hashes broadcast ON broadcast.intent_id=intent.intent_id
            WHERE intent.user_id=tx.user_id AND intent.chain=tx.chain
              AND LOWER(intent.from_address)=tx.wallet_address
              AND (LOWER(intent.tx_hash)=tx.tx_hash
                OR LOWER(intent.replacement_tx_hash)=tx.tx_hash
                OR LOWER(intent.bumped_from_tx_hash)=tx.tx_hash
                OR LOWER(broadcast.tx_hash)=tx.tx_hash)
          ) THEN 'ghostmint'
          WHEN subject.tracking_start_block IS NOT NULL
            AND tx.block_number > subject.tracking_start_block
            AND sync.provenance_complete_from_block IS NOT NULL
            AND sync.provenance_complete_through_block IS NOT NULL
            AND tx.block_number BETWEEN sync.provenance_complete_from_block
              AND sync.provenance_complete_through_block
          THEN 'external'
          ELSE 'source_unknown' END AS source
        FROM wallet_history_transactions tx
        JOIN owned_wallets wallet ON wallet.wallet_address=tx.wallet_address
        JOIN wallet_history_subjects subject
          ON subject.user_id=tx.user_id AND subject.chain=tx.chain
            AND subject.wallet_address=tx.wallet_address
        LEFT JOIN wallet_history_sync_state sync
          ON sync.user_id=tx.user_id AND sync.chain=tx.chain
            AND sync.wallet_address=tx.wallet_address
        WHERE tx.user_id=$1 AND ($3::TEXT IS NULL OR tx.chain=$3)
          AND tx.first_observed_at <= $4 AND tx.canonical=TRUE
      ), filtered AS (
        SELECT classified.* FROM classified
        WHERE ($5::TEXT IS NULL OR classified.execution_status=$5)
          AND ($6::TEXT IS NULL OR EXISTS (SELECT 1 FROM wallet_history_movements movement
            WHERE movement.user_id=classified.user_id AND movement.chain=classified.chain
              AND movement.wallet_address=classified.wallet_address AND movement.tx_hash=classified.tx_hash
              AND (movement.event_type=$6 OR movement.asset_standard=$6)))
          AND ($7::TEXT IS NULL OR EXISTS (SELECT 1 FROM wallet_history_movements movement
            WHERE movement.user_id=classified.user_id AND movement.chain=classified.chain
              AND movement.wallet_address=classified.wallet_address AND movement.tx_hash=classified.tx_hash
              AND movement.direction=$7))
          AND ($8::TEXT IS NULL OR classified.from_address=$8 OR classified.to_address=$8
            OR EXISTS (SELECT 1 FROM wallet_history_movements movement
              WHERE movement.user_id=classified.user_id AND movement.chain=classified.chain
                AND movement.wallet_address=classified.wallet_address AND movement.tx_hash=classified.tx_hash
                AND (movement.asset_address=$8 OR movement.from_address=$8 OR movement.to_address=$8)))
          AND ($9::TEXT IS NULL OR classified.tx_hash LIKE $9 || '%')
          AND ($10::TEXT IS NULL OR classified.source=$10)
      ), paged AS (
        SELECT filtered.*,
          COALESCE((SELECT JSONB_AGG(TO_JSONB(movement) - 'user_id' - 'chain' - 'wallet_address' - 'tx_hash'
            ORDER BY movement.event_locator)
            FROM wallet_history_movements movement
            WHERE movement.user_id=filtered.user_id AND movement.chain=filtered.chain
              AND movement.wallet_address=filtered.wallet_address AND movement.tx_hash=filtered.tx_hash),'[]'::JSONB)
            AS movements
        FROM filtered
        ORDER BY occurred_at DESC,chain,block_number DESC,transaction_index DESC NULLS LAST,
          tx_hash DESC,wallet_id
        LIMIT $11 OFFSET $12
      )
      SELECT paged.*,totals.result_total
      FROM (SELECT COUNT(*)::BIGINT AS result_total FROM filtered) totals
      LEFT JOIN paged ON TRUE
      ORDER BY paged.occurred_at DESC,paged.chain,paged.block_number DESC,
        paged.transaction_index DESC NULLS LAST,paged.tx_hash DESC,paged.wallet_id`, values);
    const coverageResult = coverageChains.length ? await pool.query(`WITH owned_wallets AS (
        SELECT DISTINCT ON (LOWER(address)) id,label,LOWER(address) AS wallet_address
        FROM wallets
        WHERE user_id=$1 AND ($2::BIGINT IS NULL OR id=$2)
        ORDER BY LOWER(address),id
      ), requested_chains AS (
        SELECT UNNEST($3::TEXT[]) AS chain
      )
      SELECT wallet.id AS wallet_id,wallet.label AS wallet_label,
        wallet.wallet_address,requested.chain,
        COALESCE(sync.state,'not_started') AS state,
        sync.history_complete_from_block,sync.history_complete_through_block,
        sync.provenance_complete_from_block,sync.provenance_complete_through_block,
        sync.finalized_through_block
      FROM owned_wallets wallet
      CROSS JOIN requested_chains requested
      LEFT JOIN wallet_history_subjects subject
        ON subject.user_id=$1 AND subject.chain=requested.chain
          AND subject.wallet_address=wallet.wallet_address
      LEFT JOIN wallet_history_sync_state sync
        ON sync.user_id=subject.user_id AND sync.chain=subject.chain
          AND sync.wallet_address=subject.wallet_address
      ORDER BY wallet.id,requested.chain`, [String(userId), walletId, coverageChains])
      : { rows:[] };
    const chainCoverage = coverageResult.rows.map(row => ({
      walletId:walletIdNumber(row.wallet_id),
      walletLabel:row.wallet_label,
      walletAddress:row.wallet_address,
      chain:row.chain,
      state:row.state || 'not_started',
      historyFromBlock:decimalOrNull(row.history_complete_from_block),
      historyThroughBlock:decimalOrNull(row.history_complete_through_block),
      provenanceFromBlock:decimalOrNull(row.provenance_complete_from_block),
      provenanceThroughBlock:decimalOrNull(row.provenance_complete_through_block),
      finalizedThroughBlock:decimalOrNull(row.finalized_through_block),
    }));
    const coverageState = chainCoverage.length === 0 ? 'not_started'
      : chainCoverage.every(item => item.state === chainCoverage[0].state)
        ? chainCoverage[0].state : 'mixed';
    return {
      items:result.rows.filter(row => row.tx_hash).map(mapAccountTransaction),
      total:result.rowCount ? Number(result.rows[0].result_total) : 0,
      snapshotAt:snapshotAt.toISOString(),
      snapshotScope:'first_observed_at',
      coverage:{state:coverageState,chains:chainCoverage},
    };
  }

  return { registerSubject, getSubject, listSubjects, deleteSubject, setSyncState, queueSync, beginSync,
    claimDue, releaseClaim, applyProviderPage, markSyncError, listPage, listAccountPage };
}

module.exports = { createWalletHistoryRepository, mapMovement, mapSubject, mapSyncState, mapTransaction,
  mapAccountTransaction };
