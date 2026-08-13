function mapRule(row) {
  if (!row) return null;
  return { id: row.rule_id, userId: row.user_id, name: row.name, type: row.type, method: row.method,
    config: row.config, enabled: row.enabled, cursor: row.cursor, consecutiveFailures: row.consecutive_failures,
    lastSuccessAt: row.last_success_at && new Date(row.last_success_at).getTime(),
    lastFailureAt: row.last_failure_at && new Date(row.last_failure_at).getTime(),
    nextPollAt: new Date(row.next_poll_at).getTime(), createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime() };
}

function mapEvent(row) {
  if (!row) return null;
  return { id: row.event_id, userId: row.user_id, address: row.address,
    triggerSource: row.trigger_source, platform: row.platform, sourceContentId: row.source_content_id,
    sourceUrl: row.source_url, contentHash: row.content_hash, matchedRuleIds: row.matched_rule_ids,
    detectedAt: new Date(row.detected_at).getTime(), dedupKey: row.dedup_key };
}

function createSocialWatchRepository(pool) {
  return {
    async create(userId, rule) {
      const result = await pool.query(`INSERT INTO social_watch_rules (user_id,name,type,method,config,enabled)
        VALUES ($1,$2,$3,$4,$5::JSONB,$6) RETURNING *`,
      [userId, rule.name, rule.type, rule.method, JSON.stringify(rule.config), rule.enabled]);
      return mapRule(result.rows[0]);
    },
    async get(userId, id) {
      const result = await pool.query('SELECT * FROM social_watch_rules WHERE user_id=$1 AND rule_id=$2', [userId, id]);
      return mapRule(result.rows[0]);
    },
    async list(userId) {
      const result = await pool.query('SELECT * FROM social_watch_rules WHERE user_id=$1 ORDER BY created_at', [userId]);
      return result.rows.map(mapRule);
    },
    async update(userId, id, rule) {
      const result = await pool.query(`UPDATE social_watch_rules SET name=$3,type=$4,method=$5,config=$6::JSONB,
        enabled=$7,updated_at=NOW(),next_poll_at=NOW(),consecutive_failures=0 WHERE user_id=$1 AND rule_id=$2 RETURNING *`,
      [userId, id, rule.name, rule.type, rule.method, JSON.stringify(rule.config), rule.enabled]);
      return mapRule(result.rows[0]);
    },
    async remove(userId, id) {
      const result = await pool.query('DELETE FROM social_watch_rules WHERE user_id=$1 AND rule_id=$2', [userId, id]);
      return result.rowCount > 0;
    },
    async listDue(now, limit = 50) {
      const result = await pool.query(`SELECT * FROM social_watch_rules WHERE enabled=TRUE
        AND next_poll_at <= TO_TIMESTAMP($1 / 1000.0) ORDER BY next_poll_at LIMIT $2`, [now, limit]);
      return result.rows.map(mapRule);
    },
    async markSuccess(rule, { cursor, nextPollAt }) {
      await pool.query(`UPDATE social_watch_rules SET cursor=$3::JSONB,consecutive_failures=0,last_success_at=NOW(),
        next_poll_at=TO_TIMESTAMP($4 / 1000.0),updated_at=NOW() WHERE user_id=$1 AND rule_id=$2`,
      [rule.userId, rule.id, cursor === undefined ? null : JSON.stringify(cursor), nextPollAt]);
    },
    async markFailure(rule, { nextPollAt }) {
      const result = await pool.query(`UPDATE social_watch_rules SET consecutive_failures=consecutive_failures+1,
        last_failure_at=NOW(),next_poll_at=TO_TIMESTAMP($3 / 1000.0),updated_at=NOW()
        WHERE user_id=$1 AND rule_id=$2 RETURNING consecutive_failures`, [rule.userId, rule.id, nextPollAt]);
      return result.rows[0]?.consecutive_failures || 0;
    },
    async createTrigger(event) {
      const result = await pool.query(`INSERT INTO social_trigger_events
        (user_id,address,platform,source_content_id,source_url,content_hash,matched_rule_ids,dedup_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedup_key) DO NOTHING RETURNING *`,
      [event.userId, event.address, event.platform, event.sourceContentId, event.sourceUrl,
        event.contentHash, event.matchedRuleIds, event.dedupKey]);
      return mapEvent(result.rows[0]);
    },
    async recordUsage(entry) {
      await pool.query(`INSERT INTO social_adapter_usage
        (user_id,rule_id,rule_name,adapter_method,request_type,provider_cost_usd,provider_credits,succeeded,requested_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TO_TIMESTAMP($9 / 1000.0))`,
      [entry.userId, entry.ruleId, entry.ruleName, entry.method, entry.requestType,
        entry.providerCostUsd, entry.providerCredits, entry.succeeded, entry.requestedAt]);
    },
    async usageSince(since) {
      const result = await pool.query(`SELECT rule_id,rule_name,adapter_method,request_type,
        SUM(request_count)::INTEGER AS requests,
        COALESCE(SUM(provider_cost_usd),0)::TEXT AS reported_cost_usd,
        COALESCE(SUM(provider_credits),0)::TEXT AS reported_credits
        FROM social_adapter_usage WHERE requested_at >= TO_TIMESTAMP($1 / 1000.0)
        GROUP BY rule_id,rule_name,adapter_method,request_type ORDER BY adapter_method,rule_name`, [since]);
      return result.rows.map(row => ({ ruleId:row.rule_id, ruleName:row.rule_name,
        method:row.adapter_method, requestType:row.request_type, requests:row.requests,
        reportedCostUsd:Number(row.reported_cost_usd), reportedCredits:Number(row.reported_credits) }));
    },
  };
}

module.exports = { createSocialWatchRepository, mapEvent, mapRule };
