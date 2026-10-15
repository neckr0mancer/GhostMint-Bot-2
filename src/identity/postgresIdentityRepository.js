const {
  ACCOUNT_MERGE_GRAPH_INVENTORY_VERSION,
  ACCOUNT_MERGE_GUARD_DOMAINS,
  ACCOUNT_MERGE_PLAN_VERSION,
  ACCOUNT_MERGE_SCHEMA_REVISION,
  buildAccountMergePlan,
} = require('./accountMergePlan');

// Tables holding real user data, keyed by user_id (or an equivalent creator/editor column), that
// must be empty before a duplicate account is safe to remove in mergeAccount below.
const MERGE_DATA_TABLES = [
  ['wallets', 'user_id'],
  ['wallet_history_subjects', 'user_id'],
  ['wallet_history_sync_state', 'user_id'],
  ['wallet_history_transactions', 'user_id'],
  ['wallet_history_movements', 'user_id'],
  ['mint_tasks', 'user_id'],
  ['activity', 'user_id'],
  ['pnl_records', 'user_id'],
  ['snipers', 'user_id'],
  ['sniper_seen_transactions', 'user_id'],
  ['transaction_policies', 'user_id'],
  ['transaction_intents', 'user_id'],
  ['mint_presets', 'user_id'],
  ['social_watch_rules', 'user_id'],
  ['social_trigger_events', 'user_id'],
  ['social_adapter_usage', 'user_id'],
  ['target_trigger_policies', 'user_id'],
  ['target_bypass_challenges', 'user_id'],
  ['trigger_execution_requests', 'user_id'],
  ['trigger_execution_audit', 'user_id'],
  ['bot_security_audit', 'user_id'],
  ['dashboard_sessions', 'user_id'],
  ['live_acceptance_runs', 'operator_user_id'],
  ['opensea_wallet_eligibility_authorizations', 'user_id'],
  ['group_retention_events', 'user_id'],
  ['seat_groups', 'created_by'],
  ['mode_presets', 'updated_by'],
  ['user_governance', 'updated_by'],
  ['users', 'status_changed_by'],
];

// Phase 1A of data-preserving reconciliation is deliberately read-only. These domains are the
// source-owned rows an eventual executor would have to re-key, and the active authentication
// capabilities on both accounts that must instead be revoked. Counting both sides makes the
// reviewed effect match execution: retaining an account never preserves a browser session or
// one-time authorization across an identity merge.
// Keep this inventory next to the existing empty-source guard so new ownership tables cannot be
// added to one path while being invisible to the other.
const MERGE_PREVIEW_MOVABLE_DOMAINS = [
  ['wallets', 'wallets', 'user_id'],
  ['walletHistorySubjects', 'wallet_history_subjects', 'user_id'],
  ['walletHistorySyncState', 'wallet_history_sync_state', 'user_id'],
  ['walletHistoryTransactions', 'wallet_history_transactions', 'user_id'],
  ['walletHistoryMovements', 'wallet_history_movements', 'user_id'],
  ['mintTasks', 'mint_tasks', 'user_id'],
  ['activity', 'activity', 'user_id'],
  ['pnlRecords', 'pnl_records', 'user_id'],
  ['snipers', 'snipers', 'user_id'],
  ['sniperEvents', 'sniper_seen_transactions', 'user_id'],
  ['transactionPolicies', 'transaction_policies', 'user_id'],
  ['transactionIntents', 'transaction_intents', 'user_id'],
  ['mintPresets', 'mint_presets', 'user_id'],
  ['socialWatchRules', 'social_watch_rules', 'user_id'],
  ['socialTriggerEvents', 'social_trigger_events', 'user_id'],
  ['socialAdapterUsage', 'social_adapter_usage', 'user_id'],
  ['targetTriggerPolicies', 'target_trigger_policies', 'user_id'],
  ['triggerExecutionRequests', 'trigger_execution_requests', 'user_id'],
  ['triggerExecutionAudit', 'trigger_execution_audit', 'user_id'],
  ['botSecurityAudit', 'bot_security_audit', 'user_id'],
  ['liveAcceptanceRuns', 'live_acceptance_runs', 'operator_user_id'],
  ['openSeaEligibilityAuthorizations', 'opensea_wallet_eligibility_authorizations', 'user_id'],
  ['groupRetentionEvents', 'group_retention_events', 'user_id'],
  ['seatGroupsCreated', 'seat_groups', 'created_by'],
  ['modePresetsUpdated', 'mode_presets', 'updated_by'],
  ['governanceRowsUpdated', 'user_governance', 'updated_by'],
  ['userStatusesUpdated', 'users', 'status_changed_by'],
];

const MERGE_PREVIEW_REVOCABLE_DOMAINS = [
  ['dashboardSessions', 'dashboard_sessions', 'user_id', 'revoked_at IS NULL'],
  ['accountLinkCodes', 'account_link_codes', 'user_id', 'used_at IS NULL'],
  ['targetBypassChallenges', 'target_bypass_challenges', 'user_id', 'used_at IS NULL'],
];

// Phase 1E intentionally executes only plans with no collisions and no setting choices. Every
// row below can therefore be reassigned verbatim. Children protected by migrations 072 and 073
// are omitted: updating their owned parent cascades user_id atomically and preserves the complete
// graph. wallet_history_subjects is the wallet-history ownership root; its sync, transaction, and
// movement children therefore move through their composite ON UPDATE CASCADE foreign keys.
const MERGE_EXECUTION_MOVES = [
  ['linkedAccounts', 'linked_accounts', 'user_id'],
  ['wallets', 'wallets', 'user_id'],
  ['walletHistorySubjects', 'wallet_history_subjects', 'user_id'],
  ['mintTasks', 'mint_tasks', 'user_id'],
  ['activity', 'activity', 'user_id'],
  ['pnlRecords', 'pnl_records', 'user_id'],
  ['snipers', 'snipers', 'user_id'],
  ['transactionPolicies', 'transaction_policies', 'user_id'],
  ['transactionIntents', 'transaction_intents', 'user_id'],
  ['mintPresets', 'mint_presets', 'user_id'],
  ['socialWatchRules', 'social_watch_rules', 'user_id'],
  ['socialTriggerEvents', 'social_trigger_events', 'user_id'],
  ['socialAdapterUsage', 'social_adapter_usage', 'user_id'],
  ['targetTriggerPolicies', 'target_trigger_policies', 'user_id'],
  ['triggerExecutionRequests', 'trigger_execution_requests', 'user_id'],
  ['triggerExecutionAudit', 'trigger_execution_audit', 'user_id'],
  ['botSecurityAudit', 'bot_security_audit', 'user_id'],
  ['groupRetentionEvents', 'group_retention_events', 'user_id'],
  ['launchSquads', 'launch_squads', 'user_id'],
  ['seatGroupsCreated', 'seat_groups', 'created_by'],
  ['modePresetsUpdated', 'mode_presets', 'updated_by'],
  ['governanceRowsUpdated', 'user_governance', 'updated_by'],
  ['userStatusesUpdated', 'users', 'status_changed_by'],
];

const MERGE_SERIALIZATION_RETRY_CODES = new Set(['40001', '40P01']);
const MERGE_EXECUTION_MAX_ATTEMPTS = 3;

// Plan-v3 approval fingerprints cover both accounts' complete physical ownership graphs. The
// query returns only MVCC tuple identity (xmin + ctid); encrypted keys, password/session hashes,
// authorization tokens, calldata, and platform IDs never leave PostgreSQL for this guard. A
// content UPDATE creates a new tuple version, while INSERT/DELETE changes the tuple set. Physical
// rewrites may make an otherwise-current approval stale, which is the safe failure mode.
const MERGE_GUARD_DIRECT_DOMAINS = [
  ['users', 'users', 'user_id'],
  ['linkedAccounts', 'linked_accounts', 'user_id'],
  ['accountLinkCodes', 'account_link_codes', 'user_id'],
  ['wallets', 'wallets', 'user_id'],
  ['walletHistorySubjects', 'wallet_history_subjects', 'user_id'],
  ['walletHistorySyncState', 'wallet_history_sync_state', 'user_id'],
  ['walletHistoryTransactions', 'wallet_history_transactions', 'user_id'],
  ['walletHistoryMovements', 'wallet_history_movements', 'user_id'],
  ['mintTasks', 'mint_tasks', 'user_id'],
  ['activity', 'activity', 'user_id'],
  ['pnlRecords', 'pnl_records', 'user_id'],
  ['snipers', 'snipers', 'user_id'],
  ['sniperEvents', 'sniper_seen_transactions', 'user_id'],
  ['transactionPolicies', 'transaction_policies', 'user_id'],
  ['transactionIntents', 'transaction_intents', 'user_id'],
  ['userGovernanceOwned', 'user_governance', 'user_id'],
  ['mintPresets', 'mint_presets', 'user_id'],
  ['socialWatchRules', 'social_watch_rules', 'user_id'],
  ['socialTriggerEvents', 'social_trigger_events', 'user_id'],
  ['socialAdapterUsage', 'social_adapter_usage', 'user_id'],
  ['targetTriggerPolicies', 'target_trigger_policies', 'user_id'],
  ['targetBypassChallenges', 'target_bypass_challenges', 'user_id'],
  ['triggerExecutionRequests', 'trigger_execution_requests', 'user_id'],
  ['triggerExecutionAudit', 'trigger_execution_audit', 'user_id'],
  ['botSecurityAudit', 'bot_security_audit', 'user_id'],
  ['dashboardSessions', 'dashboard_sessions', 'user_id'],
  ['liveAcceptanceRuns', 'live_acceptance_runs', 'operator_user_id'],
  ['openSeaEligibilityAuthorizations', 'opensea_wallet_eligibility_authorizations', 'user_id'],
  ['groupRetentionEvents', 'group_retention_events', 'user_id'],
  ['seatGroupsCreated', 'seat_groups', 'created_by'],
  ['modePresetsUpdated', 'mode_presets', 'updated_by'],
  ['userGovernanceUpdated', 'user_governance', 'updated_by'],
  ['userStatusesUpdated', 'users', 'status_changed_by'],
  ['mintTaskAttempts', 'mint_task_attempts', 'user_id'],
  ['mintTaskPreflightChecks', 'mint_task_preflight_checks', 'user_id'],
  ['mintTaskChangeEvents', 'mint_task_change_events', 'user_id'],
  ['sniperEventTransitions', 'sniper_event_transitions', 'user_id'],
];

function directMergeGuardQuery([domain, table, column]) {
  // Dashboard authentication slides last_seen_at and expires_at on every successful request.
  // Fingerprinting xmin/ctid here would make the execute request invalidate its own preview before
  // the serializable merge even starts. Session identity plus active/revoked state is the complete
  // merge-relevant shape: a new login, logout/revocation, or removed session still changes the
  // digest, while an ordinary authenticated heartbeat does not.
  if (domain === 'dashboardSessions') {
    return `SELECT 'dashboardSessions'::TEXT AS domain,
      CASE WHEN owned_row.${column}=$1::UUID THEN 'source' ELSE 'target' END AS side,
      CASE WHEN owned_row.revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS row_version,
      owned_row.session_id::TEXT AS row_locator
    FROM ${table} owned_row
    WHERE owned_row.${column}=$1::UUID OR owned_row.${column}=$2::UUID`;
  }
  return `SELECT '${domain}'::TEXT AS domain,
      CASE WHEN owned_row.${column}=$1::UUID THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM ${table} owned_row
    WHERE owned_row.${column}=$1::UUID OR owned_row.${column}=$2::UUID`;
}

const MERGE_GUARD_INDIRECT_QUERIES = [
  ['launchSquads', `SELECT 'launchSquads'::TEXT AS domain,
      CASE WHEN owned_row.user_id::TEXT=$1::TEXT THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM launch_squads owned_row
    WHERE owned_row.user_id::TEXT=$1::TEXT OR owned_row.user_id::TEXT=$2::TEXT`],
  ['transactionStateTransitions', `SELECT 'transactionStateTransitions'::TEXT AS domain,
      CASE WHEN owner.user_id=$1::UUID THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM transaction_state_transitions owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.intent_id
    WHERE owner.user_id=$1::UUID OR owner.user_id=$2::UUID`],
  ['transactionBroadcastHashes', `SELECT 'transactionBroadcastHashes'::TEXT AS domain,
      CASE WHEN owner.user_id=$1::UUID THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM transaction_broadcast_hashes owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.intent_id
    WHERE owner.user_id=$1::UUID OR owner.user_id=$2::UUID`],
  ['launchSquadMembers', `SELECT 'launchSquadMembers'::TEXT AS domain,
      CASE WHEN owner.user_id::TEXT=$1::TEXT THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM launch_squad_members owned_row
    JOIN launch_squads owner ON owner.id=owned_row.squad_id
    WHERE owner.user_id::TEXT=$1::TEXT OR owner.user_id::TEXT=$2::TEXT`],
  ['intentsReferencingWallets', `SELECT 'intentsReferencingWallets'::TEXT AS domain,
      CASE WHEN owner.user_id=$1::UUID THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM transaction_intents owned_row
    JOIN wallets owner ON owner.id=owned_row.wallet_id
    WHERE owner.user_id=$1::UUID OR owner.user_id=$2::UUID`],
  ['mintTasksReferencingIntents', `SELECT 'mintTasksReferencingIntents'::TEXT AS domain,
      CASE WHEN owner.user_id=$1::UUID THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM mint_tasks owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.transaction_intent_id
    WHERE owner.user_id=$1::UUID OR owner.user_id=$2::UUID`],
  ['attemptsReferencingIntents', `SELECT 'attemptsReferencingIntents'::TEXT AS domain,
      CASE WHEN owner.user_id=$1::UUID THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM mint_task_attempts owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.transaction_intent_id
    WHERE owner.user_id=$1::UUID OR owner.user_id=$2::UUID`],
  ['sniperEventsReferencingIntents', `SELECT 'sniperEventsReferencingIntents'::TEXT AS domain,
      CASE WHEN owner.user_id=$1::UUID THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM sniper_seen_transactions owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.transaction_intent_id
    WHERE owner.user_id=$1::UUID OR owner.user_id=$2::UUID`],
  ['triggerAuditReferencingIntents', `SELECT 'triggerAuditReferencingIntents'::TEXT AS domain,
      CASE WHEN owner.user_id=$1::UUID THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM trigger_execution_audit owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.transaction_intent_id
    WHERE owner.user_id=$1::UUID OR owner.user_id=$2::UUID`],
  ['liveRunsReferencingIntents', `SELECT 'liveRunsReferencingIntents'::TEXT AS domain,
      CASE WHEN owner.user_id=$1::UUID THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM live_acceptance_runs owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.intent_id
    WHERE owner.user_id=$1::UUID OR owner.user_id=$2::UUID`],
  ['usageReferencingRules', `SELECT 'usageReferencingRules'::TEXT AS domain,
      CASE WHEN owner.user_id=$1::UUID THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM social_adapter_usage owned_row
    JOIN social_watch_rules owner ON owner.rule_id=owned_row.rule_id
    WHERE owner.user_id=$1::UUID OR owner.user_id=$2::UUID`],
  ['squadMembersReferencingIntents', `SELECT 'squadMembersReferencingIntents'::TEXT AS domain,
      CASE WHEN owner.user_id=$1::UUID THEN 'source' ELSE 'target' END AS side,
      owned_row.xmin::TEXT AS row_version, owned_row.ctid::TEXT AS row_locator
    FROM launch_squad_members owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.intent_id
    WHERE owner.user_id=$1::UUID OR owner.user_id=$2::UUID`],
];

const MERGE_GUARD_ROWS_SQL = [
  ...MERGE_GUARD_DIRECT_DOMAINS.map(directMergeGuardQuery),
  ...MERGE_GUARD_INDIRECT_QUERIES.map(([, sql]) => sql),
].join('\nUNION ALL\n');

const MERGE_GUARD_GRAPH_SQL = `WITH graph_rows AS (
  ${MERGE_GUARD_ROWS_SQL}
), expected_domains(domain) AS (
  VALUES ${ACCOUNT_MERGE_GUARD_DOMAINS.map(domain => `('${domain}')`).join(',')}
), expected_sides(side) AS (
  VALUES ('source'),('target')
)
SELECT expected_domains.domain,expected_sides.side,
  COUNT(graph_rows.row_locator)::INTEGER AS row_count,
  'sha256:' || ENCODE(SHA256(CONVERT_TO(
    JSONB_BUILD_OBJECT(
      'domain',expected_domains.domain,
      'rows',COALESCE(
        JSONB_AGG(JSONB_BUILD_ARRAY(graph_rows.row_locator,graph_rows.row_version)
          ORDER BY graph_rows.row_locator,graph_rows.row_version)
          FILTER (WHERE graph_rows.row_locator IS NOT NULL),
        '[]'::JSONB
      )
    )::TEXT,
    'UTF8'
  )),'hex') AS fingerprint
FROM expected_domains
CROSS JOIN expected_sides
LEFT JOIN graph_rows ON graph_rows.domain=expected_domains.domain
  AND graph_rows.side=expected_sides.side
GROUP BY expected_domains.domain,expected_sides.side
ORDER BY expected_domains.domain,expected_sides.side`;

function assertMergeGuardInventoryParity() {
  const queried = [
    ...MERGE_GUARD_DIRECT_DOMAINS.map(([domain]) => domain),
    ...MERGE_GUARD_INDIRECT_QUERIES.map(([domain]) => domain),
  ].sort();
  const expected = [...ACCOUNT_MERGE_GUARD_DOMAINS].sort();
  if (new Set(queried).size !== queried.length
    || queried.length !== expected.length
    || queried.some((domain, index) => domain !== expected[index])) {
    throw new Error('Account merge plan-v3 guard query does not match its ownership inventory');
  }
}
assertMergeGuardInventoryParity();

function fingerprintMergeGuardRows(rows) {
  const expected = new Set();
  for (const side of ['source', 'target']) {
    for (const domain of ACCOUNT_MERGE_GUARD_DOMAINS) expected.add(`${side}:${domain}`);
  }
  const seen = new Set();
  const graph = { source: {}, target: {} };
  for (const row of rows) {
    const key = `${row.side}:${row.domain}`;
    if (!ACCOUNT_MERGE_GUARD_DOMAINS.includes(row.domain)
      || !['source', 'target'].includes(row.side)
      || seen.has(key)
      || !Number.isSafeInteger(row.row_count) || row.row_count < 0
      || typeof row.fingerprint !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(row.fingerprint)) {
      throw new Error('Account merge plan-v3 guard query returned an invalid ownership fingerprint');
    }
    seen.add(key);
    graph[row.side][row.domain] = { count: row.row_count, fingerprint: row.fingerprint };
  }
  if (seen.size !== expected.size || [...expected].some(key => !seen.has(key))) {
    throw new Error('Account merge plan-v3 guard query returned an incomplete ownership inventory');
  }
  return {
    graphInventoryVersion: ACCOUNT_MERGE_GRAPH_INVENTORY_VERSION,
    schemaRevision: ACCOUNT_MERGE_SCHEMA_REVISION,
    ownershipGraph: graph,
  };
}

function accountMergeError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function isEmptyPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 0;
}

function identitySnapshots(rows, userId) {
  return rows.filter(row => row.user_id === userId).map(row => ({
    platform: row.platform,
    platformUserId: row.platform_user_id,
    linkedAt: new Date(row.linked_at).toISOString(),
  }));
}

function positiveCountMap(value) {
  return Object.fromEntries(Object.entries(value).filter(([, count]) => Number(count) > 0));
}

function eventReceipt(row, { replayed = false } = {}) {
  return {
    status: row.status,
    outcomeCode: row.outcome_code,
    eventId: row.event_id,
    sourceUserId: row.source_user_id,
    targetUserId: row.target_user_id,
    planVersion: Number(row.plan_version),
    planDigest: row.plan_digest,
    movedCounts: row.moved_counts || {},
    revokedCounts: row.revoked_counts || {},
    finishedAt: row.finished_at instanceof Date
      ? row.finished_at.toISOString() : new Date(row.finished_at).toISOString(),
    replayed,
  };
}

function assertMatchingMergeEvent(row, expected) {
  const sameResolution = JSON.stringify(row.resolution_map || {})
    === JSON.stringify(expected.resolutionMap || {});
  if (row.actor_user_id !== expected.actorUserId
    || row.source_user_id !== expected.expectedSourceUserId
    || row.target_user_id !== expected.expectedTargetUserId
    || Number(row.plan_version) !== expected.expectedPlanVersion
    || row.plan_digest !== expected.expectedSnapshotDigest
    || !sameResolution) {
    throw accountMergeError('ACCOUNT_MERGE_IDEMPOTENCY_CONFLICT',
      'This merge request key is already attached to different evidence. Review the accounts again.');
  }
  return eventReceipt(row, { replayed: true });
}

const MERGE_EVENT_RECEIPT_SQL = `SELECT event_id,status,outcome_code,actor_user_id,source_user_id,
  target_user_id,plan_version,plan_digest,resolution_map,moved_counts,revoked_counts,finished_at
  FROM account_merge_events WHERE idempotency_key=$1`;

const MERGE_EXECUTION_DIRECT_LOCKS = (() => {
  const values = [];
  const seen = new Set();
  for (const [, table, column] of [...MERGE_GUARD_DIRECT_DOMAINS, ...MERGE_EXECUTION_MOVES]) {
    if (table === 'users' && column === 'user_id') continue;
    const key = `${table}.${column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push({ table, column });
  }
  return values;
})();

const MERGE_EXECUTION_INDIRECT_LOCK_QUERIES = [
  `SELECT owned_row.ctid FROM transaction_state_transitions owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.intent_id
    WHERE owner.user_id=$1 OR owner.user_id=$2 ORDER BY owned_row.ctid FOR UPDATE OF owned_row`,
  `SELECT owned_row.ctid FROM transaction_broadcast_hashes owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.intent_id
    WHERE owner.user_id=$1 OR owner.user_id=$2 ORDER BY owned_row.ctid FOR UPDATE OF owned_row`,
  `SELECT owned_row.ctid FROM launch_squad_members owned_row
    JOIN launch_squads owner ON owner.id=owned_row.squad_id
    WHERE owner.user_id=$1 OR owner.user_id=$2 ORDER BY owned_row.ctid FOR UPDATE OF owned_row`,
  `SELECT owned_row.ctid FROM transaction_intents owned_row
    JOIN wallets owner ON owner.id=owned_row.wallet_id
    WHERE owner.user_id=$1 OR owner.user_id=$2 ORDER BY owned_row.ctid FOR UPDATE OF owned_row`,
  `SELECT owned_row.ctid FROM mint_tasks owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.transaction_intent_id
    WHERE owner.user_id=$1 OR owner.user_id=$2 ORDER BY owned_row.ctid FOR UPDATE OF owned_row`,
  `SELECT owned_row.ctid FROM mint_task_attempts owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.transaction_intent_id
    WHERE owner.user_id=$1 OR owner.user_id=$2 ORDER BY owned_row.ctid FOR UPDATE OF owned_row`,
  `SELECT owned_row.ctid FROM sniper_seen_transactions owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.transaction_intent_id
    WHERE owner.user_id=$1 OR owner.user_id=$2 ORDER BY owned_row.ctid FOR UPDATE OF owned_row`,
  `SELECT owned_row.ctid FROM trigger_execution_audit owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.transaction_intent_id
    WHERE owner.user_id=$1 OR owner.user_id=$2 ORDER BY owned_row.ctid FOR UPDATE OF owned_row`,
  `SELECT owned_row.ctid FROM live_acceptance_runs owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.intent_id
    WHERE owner.user_id=$1 OR owner.user_id=$2 ORDER BY owned_row.ctid FOR UPDATE OF owned_row`,
  `SELECT owned_row.ctid FROM social_adapter_usage owned_row
    JOIN social_watch_rules owner ON owner.rule_id=owned_row.rule_id
    WHERE owner.user_id=$1 OR owner.user_id=$2 ORDER BY owned_row.ctid FOR UPDATE OF owned_row`,
  `SELECT owned_row.ctid FROM launch_squad_members owned_row
    JOIN transaction_intents owner ON owner.intent_id=owned_row.intent_id
    WHERE owner.user_id=$1 OR owner.user_id=$2 ORDER BY owned_row.ctid FOR UPDATE OF owned_row`,
];

async function lockAccountMergeGraph(client, sourceUserId, targetUserId) {
  const params = [sourceUserId, targetUserId];
  for (const { table, column } of MERGE_EXECUTION_DIRECT_LOCKS) {
    await client.query(`SELECT owned_row.ctid FROM ${table} owned_row
      WHERE owned_row.${column}=$1 OR owned_row.${column}=$2
      ORDER BY owned_row.ctid FOR UPDATE OF owned_row`, params);
  }
  for (const sql of MERGE_EXECUTION_INDIRECT_LOCK_QUERIES) await client.query(sql, params);
}

function assertSourceGraphRemoved(guardValues) {
  const remaining = Object.entries(guardValues.ownershipGraph.source)
    .filter(([, value]) => value.count > 0)
    .map(([domain, value]) => `${domain}:${value.count}`);
  if (remaining.length) {
    throw accountMergeError('ACCOUNT_MERGE_POSTCONDITION_FAILED',
      'The account merge could not prove that every source-owned row moved safely.', { domains: remaining });
  }
}

function assertMergeInventoryParity() {
  const key = (table, column) => `${table}.${column}`;
  const guarded = new Set(MERGE_DATA_TABLES.map(([table, column]) => key(table, column)));
  const previewed = new Set([
    ...MERGE_PREVIEW_MOVABLE_DOMAINS.map(([, table, column]) => key(table, column)),
    ...MERGE_PREVIEW_REVOCABLE_DOMAINS
      .filter(([name]) => name !== 'accountLinkCodes')
      .map(([, table, column]) => key(table, column)),
  ]);
  const missingFromGuard = [...previewed].filter(value => !guarded.has(value));
  const missingFromPreview = [...guarded].filter(value => !previewed.has(value));
  if (missingFromGuard.length || missingFromPreview.length) {
    throw new Error(`Account merge ownership inventory mismatch (guard missing: ${missingFromGuard.join(', ') || 'none'}; preview missing: ${missingFromPreview.join(', ') || 'none'})`);
  }
}
assertMergeInventoryParity();

function setPositiveCount(target, key, value) {
  const count = Number(value || 0);
  if (count > 0) target[key] = count;
}

function nonDefaultUserSettings(row) {
  const values = {};
  if (!row) return values;
  if (row.account_status && row.account_status !== 'active') values.accountStatus = row.account_status;
  if (row.status_reason) values.statusReason = row.status_reason;
  if (row.status_changed_at) values.statusChangedAt = new Date(row.status_changed_at).toISOString();
  if (row.suspended_until) values.suspendedUntil = new Date(row.suspended_until).toISOString();
  if (row.subscription_active) values.subscriptionActive = true;
  if (row.good_standing_override) values.goodStandingOverride = true;
  if (row.dashboard_theme && row.dashboard_theme !== 'ghost-mint') values.dashboardTheme = row.dashboard_theme;
  if (row.default_chain) values.defaultChain = row.default_chain;
  if (row.low_balance_threshold_native !== null && row.low_balance_threshold_native !== undefined
    && Number(row.low_balance_threshold_native) !== 0.01) {
    values.lowBalanceThresholdNative = String(row.low_balance_threshold_native);
  }
  if (row.sniper_observation_default && row.sniper_observation_default !== 'confirmed') {
    values.sniperObservationDefault = row.sniper_observation_default;
  }
  if (row.display_currency && row.display_currency !== 'USD') values.displayCurrency = row.display_currency;
  if (row.time_format && row.time_format !== '24h') values.timeFormat = row.time_format;
  if (row.username) values.username = row.username;
  if (row.security_password_hash) values.securityPassword = 'configured';
  if (row.display_name) values.displayName = row.display_name;
  if (row.bot_gate_level && row.bot_gate_level !== 'off') values.botSecurity = row.bot_gate_level;
  if (row.bot_gate_skip_mint) values.mintSecurityExemption = true;
  return values;
}

function governanceSettings(row) {
  if (!row) return null;
  const value = {};
  for (const key of ['group_id', 'max_transaction_value_wei', 'daily_spending_budget_wei',
    'gas_ceiling_gwei', 'simulation_forced', 'selected_preset_key', 'scheduled_removal_at',
    'retention_renewed_at', 'advanced_modes_allowed']) {
    if (row[key] === null || row[key] === undefined) continue;
    value[key] = row[key] instanceof Date ? row[key].toISOString() : String(row[key]);
  }
  // Presence is itself lifecycle evidence, even when every optional value is null.
  return Object.keys(value).length ? value : { present: true };
}

async function findMergeEmptinessViolations(client, userId) {
  const violations = [];

  const governance = await client.query(
    `SELECT group_id,max_transaction_value_wei,daily_spending_budget_wei,gas_ceiling_gwei,
      simulation_forced,selected_preset_key,scheduled_removal_at,retention_renewed_at,
      advanced_modes_allowed,updated_by
     FROM user_governance WHERE user_id=$1 FOR UPDATE`, [userId]);
  if (governance.rowCount) {
    // A row with currently-null ceilings can still carry lifecycle evidence (for example an
    // earlier retention renewal or the actor in updated_by). Never let the empty-account fast
    // path erase it merely because its optional policy columns happen to be null today.
    violations.push('user_governance has 1 row(s)');
  }

  const user = await client.query(
    `SELECT is_owner,is_root_owner,account_status,status_reason,status_changed_at,suspended_until,subscription_active,
      good_standing_override,dashboard_theme,default_chain,low_balance_threshold_native,
      sniper_observation_default,display_currency,time_format,username,security_password_hash,
      display_name,bot_gate_level,bot_gate_skip_mint
     FROM users WHERE user_id=$1 FOR UPDATE`, [userId]);
  if (!user.rowCount) violations.push('source account no longer exists');
  else {
    const row = user.rows[0];
    if (row.is_owner) violations.push('source account is a governance owner -- refusing to touch it');
    if (row.is_root_owner) violations.push('source account is a root owner -- refusing to touch it');
    if (row.account_status !== 'active' || row.status_reason || row.suspended_until) {
      violations.push(`source account has a non-default account_status (${row.account_status})`);
    }
    if (row.status_changed_at) violations.push('source account has account lifecycle history');
    if (row.subscription_active) violations.push('source account has subscription_active=true');
    if (row.good_standing_override) violations.push('source account has good_standing_override=true');
    if (row.dashboard_theme && row.dashboard_theme !== 'ghost-mint') violations.push('source account changed its dashboard theme');
    if (row.default_chain) violations.push('source account has a default_chain set');
    if (row.low_balance_threshold_native !== null
      && Number(row.low_balance_threshold_native) !== 0.01) {
      violations.push('source account changed its low-balance warning preference');
    }
    if (row.sniper_observation_default && row.sniper_observation_default !== 'confirmed') {
      violations.push('source account changed its sniper observation default');
    }
    if (row.display_currency && row.display_currency !== 'USD') {
      violations.push('source account changed its display currency');
    }
    if (row.time_format && row.time_format !== '24h') {
      violations.push('source account changed its time format');
    }
    if (row.username) violations.push('source account has a username');
    if (row.security_password_hash) violations.push('source account has a security password');
    if (row.display_name) violations.push('source account has a display name');
    if (row.bot_gate_level && row.bot_gate_level !== 'off') {
      violations.push('source account changed its bot security level');
    }
    if (row.bot_gate_skip_mint) violations.push('source account changed its mint security setting');
  }

  const linked = await client.query('SELECT platform,platform_user_id FROM linked_accounts WHERE user_id=$1', [userId]);
  if (linked.rowCount > 1) {
    violations.push(`source account has ${linked.rowCount} linked platform identities, not just the one being merged`);
  }

  for (const [table, column] of MERGE_DATA_TABLES) {
    const result = await client.query(`SELECT COUNT(*)::INTEGER AS count FROM ${table} WHERE ${column}=$1`, [userId]);
    if (result.rows[0].count > 0) violations.push(`${table}.${column} has ${result.rows[0].count} row(s)`);
  }
  // Cast the legacy/new column to text rather than the parameter so this check works both before
  // and after migration 072 converts launch_squads.user_id from TEXT to UUID.
  const squads = await client.query(
    'SELECT COUNT(*)::INTEGER AS count FROM launch_squads WHERE user_id::TEXT=$1',[userId]);
  if(squads.rows[0].count>0)violations.push(`launch_squads.user_id has ${squads.rows[0].count} row(s)`);

  return violations;
}

function normalizeLowBalanceThreshold(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : '0.01';
}

function createPostgresIdentityRepository(pool) {
  const repository = {
    async resolveOrCreateIdentity({ platform, platformUserId }) {
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query('BEGIN');
        inTransaction = true;
        const existing = await client.query(
          'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2 FOR UPDATE',
          [platform, platformUserId],
        );
        if (existing.rowCount) {
          await client.query('COMMIT');
          inTransaction = false;
          return existing.rows[0].user_id;
        }
        const user = await client.query('INSERT INTO users DEFAULT VALUES RETURNING user_id');
        try {
          await client.query(
            'INSERT INTO linked_accounts (user_id,platform,platform_user_id) VALUES ($1,$2,$3)',
            [user.rows[0].user_id, platform, platformUserId],
          );
          await client.query('COMMIT');
          inTransaction = false;
          return user.rows[0].user_id;
        } catch (error) {
          if (error.code !== '23505') throw error;
          await client.query('ROLLBACK');
          inTransaction = false;
          const raced = await pool.query(
            'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2',
            [platform, platformUserId],
          );
          return raced.rows[0].user_id;
        }
      } catch (error) {
        if (inTransaction) await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async getLinkedAccount(userId, platform) {
      const result = await pool.query(
        'SELECT platform_user_id FROM linked_accounts WHERE user_id=$1 AND platform=$2',
        [userId, platform],
      );
      return result.rows[0]?.platform_user_id || null;
    },

    async listLinkedAccounts(userId) {
      const result = await pool.query(
        'SELECT platform,platform_user_id FROM linked_accounts WHERE user_id=$1 ORDER BY platform',
        [userId],
      );
      return result.rows.map(row => ({ platform: row.platform, platformUserId: row.platform_user_id }));
    },

    async createLinkCode({ userId, codeHash, expiresAt }) {
      await pool.query('DELETE FROM account_link_codes WHERE user_id=$1 AND used_at IS NULL', [userId]);
      await pool.query(
        'INSERT INTO account_link_codes (code_hash,user_id,expires_at) VALUES ($1,$2,TO_TIMESTAMP($3 / 1000.0))',
        [codeHash, userId, expiresAt],
      );
    },

    async consumeLinkCode({ codeHash, platform, platformUserId, now }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const code = await client.query(
          `SELECT user_id FROM account_link_codes
           WHERE code_hash=$1 AND used_at IS NULL AND expires_at > TO_TIMESTAMP($2 / 1000.0)
           FOR UPDATE`,
          [codeHash, now],
        );
        if (!code.rowCount) {
          await client.query('ROLLBACK');
          return { status: 'invalid' };
        }
        const userId = code.rows[0].user_id;
        const linked = await client.query(
          'SELECT user_id FROM linked_accounts WHERE platform=$1 AND platform_user_id=$2 FOR UPDATE',
          [platform, platformUserId],
        );
        if (linked.rowCount && linked.rows[0].user_id !== userId) {
          await client.query('ROLLBACK');
          return { status: 'conflict' };
        }
        // A first bot interaction and a link-code submission can race. The earlier implementation
        // selected the identity, then used ON CONFLICT DO NOTHING without checking who won. If the
        // bot-first transaction inserted a different user between those two statements, this code
        // still consumed the one-time code and reported success even though the identity remained
        // attached to the wrong account. Treat every possible uniqueness conflict as a no-op, then
        // prove the durable mapping belongs to the code's user before consuming the code.
        await client.query(
          `INSERT INTO linked_accounts (user_id,platform,platform_user_id) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [userId, platform, platformUserId],
        );
        const confirmed = await client.query(
          `SELECT user_id FROM linked_accounts
           WHERE platform=$1 AND platform_user_id=$2 FOR UPDATE`,
          [platform, platformUserId],
        );
        const targetPlatform = await client.query(
          `SELECT platform_user_id FROM linked_accounts
           WHERE user_id=$1 AND platform=$2 FOR UPDATE`,
          [userId, platform],
        );
        if (!confirmed.rowCount || confirmed.rows[0].user_id !== userId
          || !targetPlatform.rowCount || targetPlatform.rows[0].platform_user_id !== platformUserId) {
          await client.query('ROLLBACK');
          return { status: 'conflict' };
        }
        await client.query('UPDATE account_link_codes SET used_at=NOW() WHERE code_hash=$1', [codeHash]);
        await client.query('COMMIT');
        return { status: 'linked', userId };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async consumeLinkCodeForSession({ codeHash, now }) {
      const result = await pool.query(
        `UPDATE account_link_codes SET used_at=NOW()
         WHERE code_hash=$1 AND used_at IS NULL AND expires_at > TO_TIMESTAMP($2 / 1000.0)
         RETURNING user_id`,
        [codeHash, now],
      );
      return result.rowCount ? { status:'linked', userId:result.rows[0].user_id } : { status:'invalid' };
    },

    // Builds a stable, sanitized reconciliation plan without changing a row. This is intentionally
    // separate from mergeAccount's empty-source fast path: a non-empty account may own signing
    // material and in-flight work, so merely showing that data is movable must never authorize a
    // move. A future executor will re-plan inside its write transaction and compare the digest.
    async previewAccountMerge({ sourcePlatform, sourcePlatformUserId, targetPlatform, targetPlatformUserId }, executionContext = {}) {
      const managedClient = !executionContext.client;
      const client = executionContext.client || await pool.connect();
      let inTransaction = false;
      try {
        if (managedClient) {
          await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          inTransaction = true;
        }
        const schemaRevision = await client.query(
          'SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1',
        );
        if (schemaRevision.rowCount !== 1
          || schemaRevision.rows[0].filename !== ACCOUNT_MERGE_SCHEMA_REVISION) {
          const error = new Error('Account merge preview requires the current ownership schema');
          error.code = 'ACCOUNT_MERGE_SCHEMA_OUTDATED';
          throw error;
        }
        const requested = await client.query(
          `SELECT platform,platform_user_id,user_id FROM linked_accounts
           WHERE (platform=$1 AND platform_user_id=$2)
              OR (platform=$3 AND platform_user_id=$4)
           ORDER BY platform,platform_user_id`,
          [sourcePlatform, sourcePlatformUserId, targetPlatform, targetPlatformUserId],
        );
        const sourceIdentity = requested.rows.find(row => row.platform === sourcePlatform
          && row.platform_user_id === sourcePlatformUserId);
        if (!sourceIdentity) {
          const error = new Error(`No linked account found for ${sourcePlatform}:${sourcePlatformUserId}`);
          error.code = 'SOURCE_NOT_FOUND';
          throw error;
        }
        const targetIdentity = requested.rows.find(row => row.platform === targetPlatform
          && row.platform_user_id === targetPlatformUserId);
        if (!targetIdentity) {
          const error = new Error(`No linked account found for ${targetPlatform}:${targetPlatformUserId}`);
          error.code = 'TARGET_NOT_FOUND';
          throw error;
        }

        const sourceUserId = sourceIdentity.user_id;
        const targetUserId = targetIdentity.user_id;
        const userIds = [...new Set([sourceUserId, targetUserId])];
        const users = await client.query(
          `SELECT user_id,created_at,is_owner,is_root_owner,account_status,status_reason,
             status_changed_at,suspended_until,subscription_active,good_standing_override,
             dashboard_theme,default_chain,low_balance_threshold_native,
             sniper_observation_default,display_currency,time_format,username,
             security_password_hash,display_name,bot_gate_level,bot_gate_skip_mint
           FROM users WHERE user_id=ANY($1::uuid[]) ORDER BY user_id`, [userIds],
        );
        if (users.rowCount !== userIds.length) throw new Error('Account merge preview found an orphaned linked identity');
        const linked = await client.query(
          `SELECT user_id,platform,platform_user_id FROM linked_accounts
           WHERE user_id=ANY($1::uuid[]) ORDER BY user_id,platform,platform_user_id`, [userIds],
        );
        const governance = await client.query(
          `SELECT user_id,group_id,max_transaction_value_wei,daily_spending_budget_wei,
             gas_ceiling_gwei,simulation_forced,selected_preset_key,scheduled_removal_at,
             retention_renewed_at,advanced_modes_allowed,updated_by
           FROM user_governance WHERE user_id=ANY($1::uuid[]) ORDER BY user_id`, [userIds],
        );
        const userRow = userId => users.rows.find(row => row.user_id === userId);
        const governanceRow = userId => governance.rows.find(row => row.user_id === userId);
        const identities = userId => linked.rows.filter(row => row.user_id === userId)
          .map(row => ({ platform: row.platform, platformUserId: row.platform_user_id }));
        const sourceRow = userRow(sourceUserId);
        const targetRow = userRow(targetUserId);
        const sourceSettings = nonDefaultUserSettings(sourceRow);
        const targetSettings = nonDefaultUserSettings(targetRow);
        const sourceGovernance = governanceSettings(governanceRow(sourceUserId));
        const targetGovernance = governanceSettings(governanceRow(targetUserId));
        if (sourceGovernance) sourceSettings.governance = sourceGovernance;
        if (targetGovernance) targetSettings.governance = targetGovernance;

        const counts = { movable: {}, revocable: {}, blocking: {} };
        for (const [key, table, column] of MERGE_PREVIEW_MOVABLE_DOMAINS) {
          const result = await client.query(
            `SELECT COUNT(*)::INTEGER AS count FROM ${table} WHERE ${column}=$1`, [sourceUserId],
          );
          setPositiveCount(counts.movable, key, result.rows[0]?.count);
        }
        for (const [key, table, column, predicate] of MERGE_PREVIEW_REVOCABLE_DOMAINS) {
          const result = await client.query(
            `SELECT COUNT(*)::INTEGER AS count FROM ${table}
             WHERE ${column}=ANY($1::UUID[]) AND ${predicate}`,
            [userIds],
          );
          setPositiveCount(counts.revocable, key, result.rows[0]?.count);
        }
        const squads = await client.query(
          'SELECT COUNT(*)::INTEGER AS count FROM launch_squads WHERE user_id::TEXT=$1', [sourceUserId],
        );
        setPositiveCount(counts.movable, 'launchSquads', squads.rows[0]?.count);

        const blockingQueries = [
          ['activeMintTasks', `SELECT COUNT(*)::INTEGER AS count FROM mint_tasks
            WHERE user_id=$1 AND status IN ('scheduled','claimed','retry','paused')`, [sourceUserId]],
          ['activePreflightWork', `SELECT COUNT(*)::INTEGER AS count FROM mint_task_preflight_checks
            WHERE user_id=$1 AND (state='claimed' OR notification_state='claimed')`, [sourceUserId]],
          ['nonfinalTransactionIntents', `SELECT COUNT(*)::INTEGER AS count FROM transaction_intents
            WHERE user_id=$1 AND state IN ('submitted','pending','unknown')`, [sourceUserId]],
          ['activeSniperEvents', `SELECT COUNT(*)::INTEGER AS count FROM sniper_seen_transactions
            WHERE user_id=$1 AND state IN ('detected','submitted')`, [sourceUserId]],
          ['activeSnipers', `SELECT COUNT(*)::INTEGER AS count FROM snipers
            WHERE user_id=$1 AND active=TRUE AND archived_at IS NULL`, [sourceUserId]],
          ['activeSocialWatchRules', `SELECT COUNT(*)::INTEGER AS count FROM social_watch_rules
            WHERE user_id=$1 AND enabled=TRUE`, [sourceUserId]],
          ['activeTriggerExecutions', `SELECT COUNT(*)::INTEGER AS count FROM trigger_execution_requests
            WHERE user_id=$1 AND status IN ('pending','executing')`, [sourceUserId]],
          ['activeLaunchSquads', `SELECT COUNT(*)::INTEGER AS count FROM launch_squads
            WHERE user_id::TEXT=$1 AND status IN ('staged','armed','firing')`, [sourceUserId]],
        ];
        for (const [key, sql, params] of blockingQueries) {
          const result = await client.query(sql, params);
          setPositiveCount(counts.blocking, key, result.rows[0]?.count);
        }

        // Migration 006 intentionally permits an intent and its wallet to have independent user
        // references, while several later links are nullable or semantic rather than composite
        // ownership FKs. A corrupt cross-owner edge cannot be assigned safely by a merge. Check
        // both accounts and reverse references from third accounts so preview fails closed.
        const integrityQueries = [
          ['crossOwnerIntentWallets', `SELECT COUNT(*)::INTEGER AS count
            FROM transaction_intents relation
            JOIN wallets owner ON owner.id=relation.wallet_id
            WHERE relation.user_id<>owner.user_id
              AND (relation.user_id=ANY($1::UUID[]) OR owner.user_id=ANY($1::UUID[]))`],
          ['crossOwnerMintTaskIntents', `SELECT COUNT(*)::INTEGER AS count
            FROM mint_tasks relation
            JOIN transaction_intents owner ON owner.intent_id=relation.transaction_intent_id
            WHERE relation.user_id<>owner.user_id
              AND (relation.user_id=ANY($1::UUID[]) OR owner.user_id=ANY($1::UUID[]))`],
          ['crossOwnerAttemptIntents', `SELECT COUNT(*)::INTEGER AS count
            FROM mint_task_attempts relation
            JOIN transaction_intents owner ON owner.intent_id=relation.transaction_intent_id
            WHERE relation.user_id<>owner.user_id
              AND (relation.user_id=ANY($1::UUID[]) OR owner.user_id=ANY($1::UUID[]))`],
          ['crossOwnerSniperEventIntents', `SELECT COUNT(*)::INTEGER AS count
            FROM sniper_seen_transactions relation
            JOIN transaction_intents owner ON owner.intent_id=relation.transaction_intent_id
            WHERE relation.user_id<>owner.user_id
              AND (relation.user_id=ANY($1::UUID[]) OR owner.user_id=ANY($1::UUID[]))`],
          ['crossOwnerTriggerAuditIntents', `SELECT COUNT(*)::INTEGER AS count
            FROM trigger_execution_audit relation
            JOIN transaction_intents owner ON owner.intent_id=relation.transaction_intent_id
            WHERE relation.user_id<>owner.user_id
              AND (relation.user_id=ANY($1::UUID[]) OR owner.user_id=ANY($1::UUID[]))`],
          ['crossOwnerLiveRunIntents', `SELECT COUNT(*)::INTEGER AS count
            FROM live_acceptance_runs relation
            JOIN transaction_intents owner ON owner.intent_id=relation.intent_id
            WHERE relation.operator_user_id<>owner.user_id
              AND (relation.operator_user_id=ANY($1::UUID[]) OR owner.user_id=ANY($1::UUID[]))`],
          ['crossOwnerSocialUsageRules', `SELECT COUNT(*)::INTEGER AS count
            FROM social_adapter_usage relation
            JOIN social_watch_rules owner ON owner.rule_id=relation.rule_id
            WHERE relation.user_id<>owner.user_id
              AND (relation.user_id=ANY($1::UUID[]) OR owner.user_id=ANY($1::UUID[]))`],
          ['crossOwnerSquadMemberIntents', `SELECT COUNT(*)::INTEGER AS count
            FROM launch_squad_members relation
            JOIN launch_squads squad ON squad.id=relation.squad_id
            JOIN transaction_intents owner ON owner.intent_id=relation.intent_id
            WHERE squad.user_id::TEXT<>owner.user_id::TEXT
              AND (squad.user_id::TEXT=ANY($1::TEXT[]) OR owner.user_id::TEXT=ANY($1::TEXT[]))`],
        ];
        for (const [key, sql] of integrityQueries) {
          const result = await client.query(sql, [userIds]);
          setPositiveCount(counts.blocking, key, result.rows[0]?.count);
        }

        if (sourceUserId !== targetUserId) {
          const collisionQueries = [
            ['walletAddressCollisions', `SELECT COUNT(*)::INTEGER AS count FROM wallets source
              JOIN wallets target ON target.user_id=$2
               AND LOWER(target.address)=LOWER(source.address) AND LOWER(target.chain)=LOWER(source.chain)
              WHERE source.user_id=$1`],
            ['walletHistorySubjectCollisions', `SELECT COUNT(*)::INTEGER AS count
              FROM wallet_history_subjects source
              JOIN wallet_history_subjects target ON target.user_id=$2
               AND target.chain=source.chain AND target.wallet_address=source.wallet_address
              WHERE source.user_id=$1`],
            ['walletLabelCollisions', `WITH source_labels AS (
                SELECT LOWER(label) AS wallet_label FROM wallets WHERE user_id=$1
                UNION SELECT LOWER(wallet_label) FROM mint_tasks WHERE user_id=$1
                UNION SELECT LOWER(wallet_label) FROM activity WHERE user_id=$1 AND wallet_label IS NOT NULL
                UNION SELECT LOWER(wallet_label) FROM snipers WHERE user_id=$1
                UNION SELECT LOWER(wallet_label) FROM target_trigger_policies
                  WHERE user_id=$1 AND wallet_label IS NOT NULL
                UNION SELECT LOWER(member.wallet_label) FROM launch_squad_members member
                  JOIN launch_squads squad ON squad.id=member.squad_id
                  WHERE squad.user_id::TEXT=$1::TEXT
              ), target_labels AS (
                SELECT LOWER(wallet_label) AS wallet_label FROM mint_tasks WHERE user_id=$2
                UNION SELECT LOWER(wallet_label) FROM activity WHERE user_id=$2 AND wallet_label IS NOT NULL
                UNION SELECT LOWER(wallet_label) FROM snipers WHERE user_id=$2
                UNION SELECT LOWER(wallet_label) FROM target_trigger_policies
                  WHERE user_id=$2 AND wallet_label IS NOT NULL
                UNION SELECT LOWER(member.wallet_label) FROM launch_squad_members member
                  JOIN launch_squads squad ON squad.id=member.squad_id
                  WHERE squad.user_id::TEXT=$2::TEXT
              )
              SELECT (
                (SELECT COUNT(*) FROM source_labels
                  JOIN wallets target ON target.user_id=$2
                    AND LOWER(target.label)=source_labels.wallet_label)
                +
                (SELECT COUNT(*) FROM target_labels
                  JOIN wallets source ON source.user_id=$1
                    AND LOWER(source.label)=target_labels.wallet_label)
              )::INTEGER AS count`],
            ['mintTaskIdCollisions', `SELECT COUNT(*)::INTEGER AS count FROM mint_tasks source
              JOIN mint_tasks target ON target.user_id=$2 AND target.id=source.id WHERE source.user_id=$1`],
            ['sniperIdCollisions', `SELECT COUNT(*)::INTEGER AS count FROM snipers source
              JOIN snipers target ON target.user_id=$2 AND target.id=source.id WHERE source.user_id=$1`],
            ['mintPresetNameCollisions', `SELECT COUNT(*)::INTEGER AS count FROM mint_presets source
              JOIN mint_presets target ON target.user_id=$2 AND LOWER(target.name)=LOWER(source.name)
              WHERE source.user_id=$1`],
            ['socialRuleNameCollisions', `SELECT COUNT(*)::INTEGER AS count FROM social_watch_rules source
              JOIN social_watch_rules target ON target.user_id=$2 AND target.name=source.name
              WHERE source.user_id=$1`],
            ['transactionPolicyCollisions', `SELECT COUNT(*)::INTEGER AS count FROM transaction_policies source
              JOIN transaction_policies target ON target.user_id=$2
               AND target.scope_type=source.scope_type AND target.scope_id=source.scope_id
              WHERE source.user_id=$1`],
            ['targetPolicyCollisions', `SELECT COUNT(*)::INTEGER AS count FROM target_trigger_policies source
              JOIN target_trigger_policies target ON target.user_id=$2
               AND target.target_type=source.target_type AND target.target_id=source.target_id
              WHERE source.user_id=$1`],
            ['triggerRequestCollisions', `SELECT COUNT(*)::INTEGER AS count FROM trigger_execution_requests source
              JOIN trigger_execution_requests target ON target.user_id=$2
               AND target.target_type=source.target_type AND target.target_id=source.target_id
               AND target.trigger_source=source.trigger_source AND target.source_event_id=source.source_event_id
              WHERE source.user_id=$1`],
            ['activeScheduleReservationCollisions', `SELECT COUNT(*)::INTEGER AS count FROM mint_tasks source
              JOIN mint_tasks target ON target.user_id=$2
               AND LOWER(target.wallet_address)=LOWER(source.wallet_address)
               AND LOWER(target.chain)=LOWER(source.chain)
               AND LOWER(target.contract_address)=LOWER(source.contract_address)
               AND target.reservation_stage_key=source.reservation_stage_key
               AND target.status IN ('scheduled','claimed','retry','paused')
              WHERE source.user_id=$1 AND source.status IN ('scheduled','claimed','retry','paused')
               AND source.wallet_address IS NOT NULL AND source.reservation_stage_key IS NOT NULL`],
          ];
          for (const [key, sql] of collisionQueries) {
            const result = await client.query(sql, [sourceUserId, targetUserId]);
            setPositiveCount(counts.blocking, key, result.rows[0]?.count);
          }
        }
        if (sourceGovernance) setPositiveCount(counts.blocking, 'sourceGovernance', 1);
        if (Object.keys(sourceSettings).some(key => key !== 'governance')) {
          setPositiveCount(counts.blocking, 'sourceAccountSettings', 1);
        }

        const guardRows = await client.query(MERGE_GUARD_GRAPH_SQL, [sourceUserId, targetUserId]);

        const plan = buildAccountMergePlan({
          source: {
            userId: sourceUserId,
            identities: identities(sourceUserId),
            flags: { isOwner: sourceRow.is_owner, isRootOwner: sourceRow.is_root_owner },
            singletonValues: sourceSettings,
          },
          target: {
            userId: targetUserId,
            identities: identities(targetUserId),
            flags: { isOwner: targetRow.is_owner, isRootOwner: targetRow.is_root_owner },
            singletonValues: targetSettings,
          },
          counts,
          guardValues: fingerprintMergeGuardRows(guardRows.rows),
        });
        if (managedClient) {
          await client.query('COMMIT');
          inTransaction = false;
        }
        return plan;
      } catch (error) {
        if (inTransaction) await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        if (managedClient) client.release();
      }
    },

    // Executes only a collision-free plan-v3 review. The caller supplies the exact account IDs,
    // digest, and confirmation it showed to the root owner; this transaction locks and rebuilds
    // that plan before a single ownership row changes. Conflict resolution is deliberately not
    // accepted here -- any blocker or choice returns a fresh review instead of guessing.
    async executeAccountMerge(input) {
      let lastRetryableError;
      for (let attempt = 1; attempt <= MERGE_EXECUTION_MAX_ATTEMPTS; attempt += 1) {
        const client = await pool.connect();
        let inTransaction = false;
        try {
          await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
          inTransaction = true;

          const actor = await client.query(
            'SELECT user_id,is_root_owner FROM users WHERE user_id=$1',
            [input.actorUserId],
          );
          if (actor.rowCount !== 1 || actor.rows[0].is_root_owner !== true) {
            throw accountMergeError('ACCOUNT_MERGE_ROOT_REQUIRED',
              'Root owner access is required to merge accounts.');
          }

          const existing = await client.query(MERGE_EVENT_RECEIPT_SQL, [input.idempotencyKey]);
          if (existing.rowCount) {
            const receipt = assertMatchingMergeEvent(existing.rows[0], input);
            await client.query('COMMIT');
            inTransaction = false;
            return receipt;
          }

          const requested = await client.query(
            `SELECT platform,platform_user_id,user_id FROM linked_accounts
             WHERE (platform=$1 AND platform_user_id=$2)
                OR (platform=$3 AND platform_user_id=$4)
             ORDER BY platform,platform_user_id FOR UPDATE`,
            [input.sourcePlatform, input.sourcePlatformUserId,
              input.targetPlatform, input.targetPlatformUserId],
          );
          const sourceIdentity = requested.rows.find(row => row.platform === input.sourcePlatform
            && row.platform_user_id === input.sourcePlatformUserId);
          const targetIdentity = requested.rows.find(row => row.platform === input.targetPlatform
            && row.platform_user_id === input.targetPlatformUserId);
          if (!sourceIdentity) throw accountMergeError('SOURCE_NOT_FOUND', 'The duplicate account could not be found.');
          if (!targetIdentity) throw accountMergeError('TARGET_NOT_FOUND', 'The account to keep could not be found.');
          const sourceUserId = sourceIdentity.user_id;
          const targetUserId = targetIdentity.user_id;
          if (sourceUserId !== input.expectedSourceUserId
            || targetUserId !== input.expectedTargetUserId
            || sourceUserId === targetUserId) {
            throw accountMergeError('ACCOUNT_MERGE_STALE',
              'These accounts changed after review. Review them again before merging.',
              { reviewRequired: true });
          }

          const lockedUserIds = [...new Set([input.actorUserId, sourceUserId, targetUserId])];
          const accountRows = await client.query(
            `SELECT user_id,is_root_owner FROM users
             WHERE user_id=ANY($1::UUID[]) ORDER BY user_id FOR UPDATE`,
            [lockedUserIds],
          );
          const lockedActor = accountRows.rows.find(row => row.user_id === input.actorUserId);
          if (accountRows.rowCount !== lockedUserIds.length) {
            throw accountMergeError('ACCOUNT_MERGE_STALE',
              'One of these accounts changed after review. Review them again before merging.',
              { reviewRequired: true });
          }
          if (lockedActor?.is_root_owner !== true) {
            throw accountMergeError('ACCOUNT_MERGE_ROOT_REQUIRED',
              'Root owner access is required to merge accounts.');
          }

          await lockAccountMergeGraph(client, sourceUserId, targetUserId);
          const plan = await repository.previewAccountMerge({
            sourcePlatform: input.sourcePlatform,
            sourcePlatformUserId: input.sourcePlatformUserId,
            targetPlatform: input.targetPlatform,
            targetPlatformUserId: input.targetPlatformUserId,
          }, { client });
          const planMatches = plan.sourceUserId === input.expectedSourceUserId
            && plan.targetUserId === input.expectedTargetUserId
            && plan.planVersion === input.expectedPlanVersion
            && plan.snapshotDigest === input.expectedSnapshotDigest;
          if (!planMatches) {
            throw accountMergeError('ACCOUNT_MERGE_STALE',
              'These accounts changed after review. Review them again before merging.',
              { freshPlan: plan });
          }
          if (plan.classification !== 'ready' || plan.requiredChoices.length
            || plan.blockers.length || !isEmptyPlainObject(input.resolutionMap)) {
            throw accountMergeError('ACCOUNT_MERGE_NOT_READY',
              'This account merge has unresolved records or choices. Nothing was changed.',
              { freshPlan: plan });
          }
          if (plan.planVersion !== ACCOUNT_MERGE_PLAN_VERSION) {
            throw accountMergeError('ACCOUNT_MERGE_STALE',
              'The account merge format changed. Review the accounts again.', { freshPlan: plan });
          }

          const beforeIdentitiesResult = await client.query(
            `SELECT user_id,platform,platform_user_id,linked_at FROM linked_accounts
             WHERE user_id=ANY($1::UUID[]) ORDER BY user_id,platform,platform_user_id`,
            [[input.actorUserId, sourceUserId, targetUserId]],
          );
          const actorIdentities = identitySnapshots(beforeIdentitiesResult.rows, input.actorUserId);
          const sourceIdentitiesBefore = identitySnapshots(beforeIdentitiesResult.rows, sourceUserId);
          const targetIdentitiesBefore = identitySnapshots(beforeIdentitiesResult.rows, targetUserId);
          if (!actorIdentities.length || !sourceIdentitiesBefore.length || !targetIdentitiesBefore.length) {
            throw accountMergeError('ACCOUNT_MERGE_EVIDENCE_INCOMPLETE',
              'The merge could not preserve complete identity evidence. Nothing was changed.');
          }

          const started = await client.query('SELECT clock_timestamp() AS started_at');
          const startedAt = started.rows[0].started_at;
          const expectedMovedCounts = Object.fromEntries(plan.summary.movable.domains
            .map(item => [item.key, item.count]));
          expectedMovedCounts.linkedAccounts = plan.summary.sourceIdentityCount;
          for (const [key, table, column] of MERGE_EXECUTION_MOVES) {
            const moved = await client.query(
              `UPDATE ${table} SET ${column}=$2 WHERE ${column}=$1`,
              [sourceUserId, targetUserId],
            );
            const expected = Number(expectedMovedCounts[key] || 0);
            if (moved.rowCount !== expected) {
              throw accountMergeError('ACCOUNT_MERGE_POSTCONDITION_FAILED',
                'An ownership row changed while the merge was running. Nothing was changed.',
                { domain: key, expected, actual: moved.rowCount });
            }
          }

          const accountIds = [sourceUserId, targetUserId];
          const revokedSessions = await client.query(
            `UPDATE dashboard_sessions SET revoked_at=NOW(),revoked_reason='account_merge'
             WHERE user_id=ANY($1::UUID[]) AND revoked_at IS NULL`, [accountIds],
          );
          const deletedLinkCodes = await client.query(
            'DELETE FROM account_link_codes WHERE user_id=ANY($1::UUID[]) AND used_at IS NULL',
            [accountIds],
          );
          const deletedBypassChallenges = await client.query(
            'DELETE FROM target_bypass_challenges WHERE user_id=ANY($1::UUID[]) AND used_at IS NULL',
            [accountIds],
          );
          const actualRevokedCounts = {
            dashboardSessions: revokedSessions.rowCount,
            accountLinkCodes: deletedLinkCodes.rowCount,
            targetBypassChallenges: deletedBypassChallenges.rowCount,
          };
          const expectedRevokedCounts = Object.fromEntries(plan.summary.revocable.domains
            .map(item => [item.key, item.count]));
          for (const [domain, actual] of Object.entries(actualRevokedCounts)) {
            const expected = Number(expectedRevokedCounts[domain] || 0);
            if (actual !== expected) {
              throw accountMergeError('ACCOUNT_MERGE_POSTCONDITION_FAILED',
                'Authentication access changed while the merge was running. Nothing was changed.',
                { domain, expected, actual });
            }
          }
          const revokedCounts = positiveCountMap(actualRevokedCounts);

          const targetAfterResult = await client.query(
            `SELECT user_id,platform,platform_user_id,linked_at FROM linked_accounts
             WHERE user_id=$1 ORDER BY platform,platform_user_id`, [targetUserId],
          );
          const targetIdentitiesAfter = identitySnapshots(targetAfterResult.rows, targetUserId);
          if (targetIdentitiesAfter.length
            !== sourceIdentitiesBefore.length + targetIdentitiesBefore.length) {
            throw accountMergeError('ACCOUNT_MERGE_POSTCONDITION_FAILED',
              'The merged identities could not be verified. Nothing was changed.');
          }

          const removed = await client.query('DELETE FROM users WHERE user_id=$1', [sourceUserId]);
          if (removed.rowCount !== 1) {
            throw accountMergeError('ACCOUNT_MERGE_POSTCONDITION_FAILED',
              'The duplicate account could not be removed safely. Nothing was changed.');
          }
          const postGuard = await client.query(MERGE_GUARD_GRAPH_SQL, [sourceUserId, targetUserId]);
          assertSourceGraphRemoved(fingerprintMergeGuardRows(postGuard.rows));

          const movedCounts = positiveCountMap(expectedMovedCounts);
          const evidence = {
            executor: 'ready_plan_v3',
            schemaRevision: ACCOUNT_MERGE_SCHEMA_REVISION,
            graphInventoryVersion: ACCOUNT_MERGE_GRAPH_INVENTORY_VERSION,
            sourceIdentityCount: sourceIdentitiesBefore.length,
            targetIdentityCountBefore: targetIdentitiesBefore.length,
            targetIdentityCountAfter: targetIdentitiesAfter.length,
          };
          const inserted = await client.query(
            `INSERT INTO account_merge_events (
              idempotency_key,status,outcome_code,actor_user_id,source_user_id,target_user_id,
              actor_identities,source_identities_before,target_identities_before,target_identities_after,
              plan_version,plan_digest,resolution_map,moved_counts,revoked_counts,evidence,
              requested_at,started_at,finished_at
            ) VALUES (
              $1,'committed','MERGE_COMMITTED',$2,$3,$4,$5::JSONB,$6::JSONB,$7::JSONB,$8::JSONB,
              $9,$10,$11::JSONB,$12::JSONB,$13::JSONB,$14::JSONB,$15,$15,clock_timestamp()
            ) RETURNING event_id,status,outcome_code,actor_user_id,source_user_id,target_user_id,
              plan_version,plan_digest,resolution_map,moved_counts,revoked_counts,finished_at`,
            [input.idempotencyKey, input.actorUserId, sourceUserId, targetUserId,
              JSON.stringify(actorIdentities), JSON.stringify(sourceIdentitiesBefore),
              JSON.stringify(targetIdentitiesBefore), JSON.stringify(targetIdentitiesAfter),
              plan.planVersion, plan.snapshotDigest, JSON.stringify(input.resolutionMap),
              JSON.stringify(movedCounts), JSON.stringify(revokedCounts), JSON.stringify(evidence),
              startedAt],
          );
          await client.query('COMMIT');
          inTransaction = false;
          return eventReceipt(inserted.rows[0]);
        } catch (error) {
          if (inTransaction) await client.query('ROLLBACK').catch(() => {});
          inTransaction = false;
          if (MERGE_SERIALIZATION_RETRY_CODES.has(error.code)) {
            lastRetryableError = error;
            if (attempt < MERGE_EXECUTION_MAX_ATTEMPTS) continue;
            throw accountMergeError('ACCOUNT_MERGE_RETRY_EXHAUSTED',
              'The accounts changed repeatedly while merging. Review them and try again.');
          }
          throw error;
        } finally {
          client.release();
        }
      }
      throw accountMergeError('ACCOUNT_MERGE_RETRY_EXHAUSTED',
        'The accounts changed repeatedly while merging. Review them and try again.',
        lastRetryableError ? { databaseCode: lastRetryableError.code } : undefined);
    },

    // Repoints a source platform identity's linked_accounts row onto an existing target account
    // and removes the now-orphaned source account -- but only once verified empty. Both platforms
    // auto-create their own account on first contact (resolveOrCreateIdentity above), so using one
    // platform before it's ever linked to an existing account leaves it stranded on its own
    // separate account; a link code from another platform then correctly refuses to attach to it.
    // Throws a plain Error tagged with .code (SOURCE_NOT_FOUND / TARGET_NOT_FOUND /
    // TARGET_PLATFORM_CONFLICT / ACCOUNT_NOT_EMPTY) for every expected refusal reason -- the
    // service layer translates these into a ValidationError with a safe, specific message. A
    // non-empty duplicate is left entirely untouched; this never attempts to move real data.
    async mergeAccount({ sourcePlatform, sourcePlatformUserId, targetPlatform, targetPlatformUserId }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Lock both requested identities in one stable order. Two administrators can otherwise
        // submit opposite-direction merges at the same time and each hold one linked row while
        // waiting forever for the other.
        const identities = await client.query(
          `SELECT platform,platform_user_id,user_id FROM linked_accounts
           WHERE (platform=$1 AND platform_user_id=$2)
              OR (platform=$3 AND platform_user_id=$4)
           ORDER BY platform,platform_user_id FOR UPDATE`,
          [sourcePlatform, sourcePlatformUserId, targetPlatform, targetPlatformUserId]);
        const source = identities.rows.find(row => row.platform === sourcePlatform
          && row.platform_user_id === sourcePlatformUserId);
        if (!source) {
          const error = new Error(`No linked account found for ${sourcePlatform}:${sourcePlatformUserId}`);
          error.code = 'SOURCE_NOT_FOUND';
          throw error;
        }
        const target = identities.rows.find(row => row.platform === targetPlatform
          && row.platform_user_id === targetPlatformUserId);
        if (!target) {
          const error = new Error(`No linked account found for ${targetPlatform}:${targetPlatformUserId}`);
          error.code = 'TARGET_NOT_FOUND';
          throw error;
        }

        const sourceUserId = source.user_id;
        const targetUserId = target.user_id;
        if (sourceUserId === targetUserId) {
          await client.query('COMMIT');
          return { sourceUserId, targetUserId, status: 'already_unified' };
        }

        // Lock both account rows in deterministic order. Besides stabilising the account flags
        // checked below, this prevents new FK-owned rows from being attached to the disposable
        // source while its emptiness is being proved.
        await client.query(
          'SELECT user_id FROM users WHERE user_id=ANY($1::uuid[]) ORDER BY user_id FOR UPDATE',
          [[sourceUserId,targetUserId]],
        );
        // SHARE blocks a pre-072 legacy writer from racing the emptiness check. It is redundant but
        // harmless once migration 072 gives launch_squads a UUID account foreign key, keeping this
        // code safe across a rolling migration.
        await client.query('LOCK TABLE launch_squads IN SHARE MODE');
        const targetPlatformConflict=await client.query(
          `SELECT platform_user_id FROM linked_accounts
           WHERE user_id=$1 AND platform=$2 FOR UPDATE`,[targetUserId,sourcePlatform]);
        if(targetPlatformConflict.rowCount){
          const error=new Error(`The account being kept already has a different ${sourcePlatform} identity`);
          error.code='TARGET_PLATFORM_CONFLICT';
          throw error;
        }

        const violations = await findMergeEmptinessViolations(client, sourceUserId);
        if (violations.length) {
          const error = new Error(`Source account is not empty, refusing to merge: ${violations.join('; ')}`);
          error.code = 'ACCOUNT_NOT_EMPTY';
          throw error;
        }

        await client.query(
          'UPDATE linked_accounts SET user_id=$2 WHERE platform=$3 AND platform_user_id=$4 AND user_id=$1',
          [sourceUserId, targetUserId, sourcePlatform, sourcePlatformUserId]);
        await client.query('DELETE FROM account_link_codes WHERE user_id=$1', [sourceUserId]);
        await client.query('DELETE FROM users WHERE user_id=$1', [sourceUserId]);

        await client.query('COMMIT');
        return { sourceUserId, targetUserId };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async getTheme(userId) {
      const result = await pool.query('SELECT dashboard_theme FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.dashboard_theme || 'ghost-mint';
    },

    async setTheme(userId, theme) {
      await pool.query('UPDATE users SET dashboard_theme=$2 WHERE user_id=$1', [userId, theme]);
      return theme;
    },

    async getDisplayName(userId) {
      const result = await pool.query('SELECT display_name FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.display_name || null;
    },

    async setDisplayName(userId, displayName) {
      await pool.query('UPDATE users SET display_name=$2 WHERE user_id=$1', [userId, displayName]);
      return displayName;
    },

    async getDefaultChain(userId) {
      const result = await pool.query('SELECT default_chain FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.default_chain || null;
    },

    async setDefaultChain(userId, defaultChain) {
      await pool.query('UPDATE users SET default_chain=$2 WHERE user_id=$1', [userId, defaultChain]);
      return defaultChain;
    },

    async getLowBalanceThreshold(userId) {
      const result = await pool.query(
        'SELECT low_balance_threshold_native::TEXT AS value FROM users WHERE user_id=$1', [userId],
      );
      return normalizeLowBalanceThreshold(result.rows[0]?.value);
    },

    async setLowBalanceThreshold(userId, value) {
      const result = await pool.query(`UPDATE users SET low_balance_threshold_native=$2
        WHERE user_id=$1 RETURNING low_balance_threshold_native::TEXT AS value`, [userId, value]);
      if (!result.rowCount) throw new Error('User not found');
      return normalizeLowBalanceThreshold(result.rows[0].value);
    },

    async getDisplayCurrency(userId) {
      const result = await pool.query('SELECT display_currency FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.display_currency || 'USD';
    },

    async setDisplayCurrency(userId, value) {
      const result = await pool.query(`UPDATE users SET display_currency=$2
        WHERE user_id=$1 RETURNING display_currency`, [userId, value]);
      if (!result.rowCount) throw new Error('User not found');
      return result.rows[0].display_currency;
    },

    async getTimeFormat(userId) {
      const result = await pool.query('SELECT time_format FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.time_format || '24h';
    },

    async setTimeFormat(userId, value) {
      const result = await pool.query(`UPDATE users SET time_format=$2
        WHERE user_id=$1 RETURNING time_format`, [userId, value]);
      if (!result.rowCount) throw new Error('User not found');
      return result.rows[0].time_format;
    },

    async getSniperObservationDefault(userId) {
      const result = await pool.query('SELECT sniper_observation_default FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.sniper_observation_default || 'confirmed';
    },

    async setSniperObservationDefault(userId, observationMode) {
      await pool.query('UPDATE users SET sniper_observation_default=$2 WHERE user_id=$1', [userId, observationMode]);
      return observationMode;
    },

    // Bot action gate (migration 041). Defaults to 'off' for a row that somehow has no value:
    // the gate must fail open to today's behaviour rather than locking someone out of their own
    // wallets because a read went wrong.
    async getBotGateLevel(userId) {
      // Swallows the read error deliberately. This is consulted before every gated action, and a
      // gate that ships off must never be the reason an owner cannot reach their own wallets -- if
      // the column is missing (migration not yet applied) or the read fails, the honest answer is
      // the default everyone already has rather than an outage on wallet removal.
      try {
        const result = await pool.query('SELECT bot_gate_level FROM users WHERE user_id=$1', [userId]);
        return result.rows[0]?.bot_gate_level || 'off';
      } catch {
        return 'off';
      }
    },

    // Exempts interactive minting from the gate. Falls back to FALSE (still gated) on a read
    // failure: an exemption only ever opens a door, so the safe fallback is not to open it.
    async getBotGateSkipMint(userId) {
      try {
        const result = await pool.query('SELECT bot_gate_skip_mint FROM users WHERE user_id=$1', [userId]);
        return Boolean(result.rows[0]?.bot_gate_skip_mint);
      } catch {
        return false;
      }
    },

    async setBotGateSkipMint(userId, value) {
      await pool.query('UPDATE users SET bot_gate_skip_mint=$2 WHERE user_id=$1', [userId, Boolean(value)]);
    },

    async setBotGateLevel(userId, level) {
      await pool.query('UPDATE users SET bot_gate_level=$2 WHERE user_id=$1', [userId, level]);
    },

    async getSecurityPasswordHash(userId) {
      const result = await pool.query('SELECT security_password_hash FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.security_password_hash || null;
    },

    async setSecurityPasswordHash(userId, hash) {
      await pool.query('UPDATE users SET security_password_hash=$2 WHERE user_id=$1', [userId, hash]);
    },

    async getUsername(userId) {
      const result = await pool.query('SELECT username FROM users WHERE user_id=$1', [userId]);
      return result.rows[0]?.username || null;
    },

    async setUsername(userId, value) {
      try {
        await pool.query('UPDATE users SET username=$2 WHERE user_id=$1', [userId, value]);
      } catch (error) {
        if (error.code === '23505') throw new UsernameTakenError();
        throw error;
      }
    },

    async findUserIdByUsername(value) {
      const result = await pool.query('SELECT user_id FROM users WHERE username=$1', [value]);
      return result.rows[0]?.user_id || null;
    },
  };
  return repository;
}

class UsernameTakenError extends Error {
  constructor() {
    super('That username is already taken');
    this.name = 'UsernameTakenError';
  }
}

module.exports = { UsernameTakenError, createPostgresIdentityRepository };
