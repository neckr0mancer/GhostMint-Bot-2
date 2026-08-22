// Durable state for launch squads (see migrations/048_launch_squads.sql). Follows the
// schedulerRepository shape: pool injected, row mappers at top, narrow method surface.
function mapSquad(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, name: row.name, chain: row.chain,
    contractAddress: row.contract_address, quantity: row.quantity,
    methodSignature: row.method_signature, seaDropAddress: row.sea_drop_address,
    feeRecipient: row.fee_recipient,
    priceWei: row.price_wei === null || row.price_wei === undefined ? null : BigInt(row.price_wei),
    gasPriceWei: row.gas_price_wei === null || row.gas_price_wei === undefined ? null : BigInt(row.gas_price_wei),
    triggerType: row.trigger_type, fireAt: row.fire_at ? new Date(row.fire_at).getTime() : null,
    targetBlock: row.target_block === null || row.target_block === undefined ? null : Number(row.target_block),
    status: row.status, waveSize: row.wave_size,
    createdAt: new Date(row.created_at).getTime(), firedAt: row.fired_at ? new Date(row.fired_at).getTime() : null,
    report: row.report || null,
  };
}
function mapMember(row) {
  if (!row) return null;
  return {
    squadId: row.squad_id, walletLabel: row.wallet_label, wave: row.wave, priority: row.priority,
    status: row.status, txHash: row.tx_hash, intentId: row.intent_id, error: row.error,
    sentAt: row.sent_at ? new Date(row.sent_at).getTime() : null,
    confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).getTime() : null,
  };
}

function createLaunchRepository(pool) {
  return {
    async createSquad(squad) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO launch_squads
          (id,user_id,name,chain,contract_address,quantity,method_signature,sea_drop_address,fee_recipient,
           price_wei,gas_price_wei,trigger_type,fire_at,status,wave_size)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [squad.id, squad.userId, squad.name, squad.chain, squad.contractAddress, squad.quantity,
          squad.methodSignature || 'mint(uint256)', squad.seaDropAddress ?? null, squad.feeRecipient ?? null,
          squad.priceWei === null || squad.priceWei === undefined ? null : squad.priceWei.toString(),
          squad.gasPriceWei ? squad.gasPriceWei.toString() : null,
          squad.triggerType || 'manual', squad.fireAt ? new Date(squad.fireAt).toISOString() : null,
          squad.status || 'drafting', squad.waveSize || 25]);
        for (const member of squad.members || []) {
          await client.query(`INSERT INTO launch_squad_members
            (squad_id,wallet_label,wave,priority,status) VALUES ($1,$2,$3,$4,'pending')`,
          [squad.id, member.walletLabel ?? member.label, member.wave, member.priority]);
        }
        await client.query('COMMIT');
        return squad.id;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async getSquad(userId, id) {
      const result = await pool.query('SELECT * FROM launch_squads WHERE id=$1 AND user_id=$2', [id, userId]);
      const squad = mapSquad(result.rows[0]);
      if (!squad) return null;
      const members = await pool.query('SELECT * FROM launch_squad_members WHERE squad_id=$1 ORDER BY wave,priority,sent_at', [id]);
      return { ...squad, members: members.rows.map(mapMember) };
    },
    // Internal (non-user-scoped) load for the launcher itself -- command surfaces must keep using
    // getSquad so ownership is always enforced where user input enters.
    async getSquadById(id) {
      const result = await pool.query('SELECT * FROM launch_squads WHERE id=$1', [id]);
      const squad = mapSquad(result.rows[0]);
      if (!squad) return null;
      const members = await pool.query('SELECT * FROM launch_squad_members WHERE squad_id=$1 ORDER BY wave,priority,sent_at', [id]);
      return { ...squad, members: members.rows.map(mapMember) };
    },
    // Atomic fire claim, same shape as schedulerRepository.claimDue's WHERE-guarded UPDATE: only
    // one caller ever moves a squad from staged/armed into firing, so a timer tick and an eager
    // FIRE button (or two ticks) racing each other cannot start the burst twice.
    async claimForFire(id) {
      const result = await pool.query(
        `UPDATE launch_squads SET status='firing', fired_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND status IN ('staged','armed') RETURNING *`, [id]);
      return result.rowCount > 0;
    },
    async listSquads(userId, { limit = 20 } = {}) {
      const result = await pool.query('SELECT * FROM launch_squads WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
      return result.rows.map(mapSquad);
    },
    // Squads whose timer has come due. Only staged/armed squads qualify -- a drafting squad was
    // never verified, and anything already firing/done must not re-fire (idempotency key makes a
    // duplicate harmless anyway, but not claiming it is cheaper and clearer).
    async listDueTimerSquads(nowMs) {
      const result = await pool.query(
        `SELECT * FROM launch_squads WHERE trigger_type='timer' AND status IN ('staged','armed') AND fire_at <= TO_TIMESTAMP($1 / 1000.0)`,
        [nowMs]);
      return result.rows.map(mapSquad);
    },
    // Staged squads waiting on an event trigger (block height / pending tx). The launcher arms a
    // live subscription for each of these; squads already armed are filtered by the caller.
    async listTriggerCandidates() {
      const result = await pool.query(
        `SELECT * FROM launch_squads WHERE status='staged' AND trigger_type IN ('block','pending')`);
      return result.rows.map(mapSquad);
    },
    async updateSquad(id, fields = {}) {
      const sets = []; const params = []; let n = 1;
      for (const [key, value] of Object.entries(fields)) {
        const column = { status: 'status', firedAt: 'fired_at', report: 'report', seaDropAddress: 'sea_drop_address',
          feeRecipient: 'fee_recipient', priceWei: 'price_wei', methodSignature: 'method_signature',
          gasPriceWei: 'gas_price_wei', triggerType: 'trigger_type', fireAt: 'fire_at',
          targetBlock: 'target_block' }[key];
        if (!column) continue;
        sets.push(`${column}=$${n}`);
        params.push(value instanceof Date ? value.toISOString()
          : typeof value === 'bigint' ? value.toString()
          : value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
        n += 1;
      }
      if (!sets.length) return;
      params.push(id);
      await pool.query(`UPDATE launch_squads SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${n}`, params);
    },
    async updateMemberStatus(squadId, walletLabel, fields = {}) {
      const sets = []; const params = []; let n = 1;
      for (const [key, value] of Object.entries(fields)) {
        const column = { status: 'status', txHash: 'tx_hash', intentId: 'intent_id', error: 'error',
          sentAt: 'sent_at', confirmedAt: 'confirmed_at' }[key];
        if (!column) continue;
        sets.push(`${column}=$${n}`);
        params.push(value instanceof Date ? value.toISOString() : value);
        n += 1;
      }
      if (!sets.length) return;
      params.push(squadId, walletLabel);
      await pool.query(`UPDATE launch_squad_members SET ${sets.join(',')} WHERE squad_id=$${n} AND wallet_label=$${n + 1}`, params);
    },
  };
}

module.exports = { createLaunchRepository };
