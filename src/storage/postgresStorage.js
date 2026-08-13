function number(value) { return value === null ? null : Number(value); }
function time(value) { return value === null ? null : new Date(value).getTime(); }

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
    price: number(row.price_eth), gas: number(row.gas_gwei), mintTime: time(row.mint_time),
    status: row.status, createdAt: time(row.created_at),
  };
}

function mapActivity(row) {
  return { id: Number(row.id), userId: row.user_id, status: row.status, title: row.title,
    walletLabel: row.wallet_label, txHash: row.tx_hash, explorer: row.explorer, time: time(row.occurred_at) };
}

function mapPnl(row) {
  return { id: Number(row.id), userId: row.user_id, nm: row.name, cost: number(row.cost),
    sale: number(row.sale), gas: number(row.gas), net: number(row.net), t: time(row.created_at) };
}

function mapSniper(row) {
  return {
    id: row.id, userId: row.user_id, label: row.label, targetAddress: row.target_address,
    chain: row.chain, walletLabel: row.wallet_label, valueMode: row.value_mode,
    fixedValueETH: number(row.fixed_value_eth), maxValueETH: number(row.max_value_eth),
    gasBoostPercent: row.gas_boost_percent, active: row.active, hits: row.hits,
    fails: row.fails, lastFiredAt: time(row.last_fired_at), createdAt: time(row.created_at),
  };
}

function createPostgresStorage(pool) {
  async function loadState(userId = null) {
    const where = userId ? ' WHERE user_id=$1' : '';
    const values = userId ? [userId] : [];
    const [wallets, tasks, activity, pnl, snipers] = await Promise.all([
      pool.query(`SELECT * FROM wallets${where} ORDER BY id`, values),
      pool.query(`SELECT * FROM mint_tasks${where} ORDER BY created_at`, values),
      pool.query(`SELECT * FROM activity${where} ORDER BY occurred_at DESC LIMIT 200`, values),
      pool.query(`SELECT * FROM pnl_records${where} ORDER BY created_at DESC`, values),
      pool.query(`SELECT * FROM snipers${where} ORDER BY created_at`, values),
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

    async saveTask(task) {
      const result = await pool.query(`INSERT INTO mint_tasks
        (user_id,id,name,wallet_label,contract_address,function_name,quantity,price_eth,gas_gwei,mint_time,status,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TO_TIMESTAMP($10 / 1000.0),$11,TO_TIMESTAMP($12 / 1000.0))
        ON CONFLICT (user_id,id) DO UPDATE SET name=EXCLUDED.name,wallet_label=EXCLUDED.wallet_label,
        contract_address=EXCLUDED.contract_address,function_name=EXCLUDED.function_name,
        quantity=EXCLUDED.quantity,price_eth=EXCLUDED.price_eth,gas_gwei=EXCLUDED.gas_gwei,
        mint_time=EXCLUDED.mint_time,status=EXCLUDED.status
        RETURNING id`,
      [task.userId, task.id, task.name, task.walletLabel, task.contract, task.fn || 'mint', task.qty,
        task.price || 0, task.gas ?? null, task.mintTime, task.status, task.createdAt || Date.now()]);
      return result.rowCount > 0;
    },
    async deleteTask(userId, id) {
      const result = await pool.query('DELETE FROM mint_tasks WHERE user_id=$1 AND id=$2', [userId, id]);
      return result.rowCount > 0;
    },

    async addActivity(entry) {
      const result = await pool.query(`INSERT INTO activity
        (user_id,status,title,wallet_label,tx_hash,explorer,occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,TO_TIMESTAMP($7 / 1000.0)) RETURNING *`,
      [entry.userId, entry.status, entry.title, entry.walletLabel, entry.txHash, entry.explorer, entry.time]);
      return mapActivity(result.rows[0]);
    },
    async addPnl(record) {
      const result = await pool.query(`INSERT INTO pnl_records (user_id,name,cost,sale,gas,net,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,TO_TIMESTAMP($7 / 1000.0)) RETURNING *`,
      [record.userId, record.nm, record.cost, record.sale, record.gas, record.net, record.t]);
      return mapPnl(result.rows[0]);
    },
    async deletePnl(userId, id) {
      const result = await pool.query('DELETE FROM pnl_records WHERE user_id=$1 AND id=$2', [userId, id]);
      return result.rowCount > 0;
    },

    async saveSniper(sniper) {
      const result = await pool.query(`INSERT INTO snipers
        (user_id,id,label,target_address,chain,wallet_label,value_mode,fixed_value_eth,max_value_eth,
          gas_boost_percent,active,hits,fails,last_fired_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
          CASE WHEN $14::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($14 / 1000.0) END,
          TO_TIMESTAMP($15 / 1000.0))
        ON CONFLICT (user_id,id) DO UPDATE SET label=EXCLUDED.label,target_address=EXCLUDED.target_address,
        chain=EXCLUDED.chain,wallet_label=EXCLUDED.wallet_label,value_mode=EXCLUDED.value_mode,
        fixed_value_eth=EXCLUDED.fixed_value_eth,max_value_eth=EXCLUDED.max_value_eth,
        gas_boost_percent=EXCLUDED.gas_boost_percent,active=EXCLUDED.active,hits=EXCLUDED.hits,
        fails=EXCLUDED.fails,last_fired_at=EXCLUDED.last_fired_at
        RETURNING id`,
      [sniper.userId, sniper.id, sniper.label, sniper.targetAddress, sniper.chain, sniper.walletLabel,
        sniper.valueMode, sniper.fixedValueETH || 0, sniper.maxValueETH, sniper.gasBoostPercent,
        sniper.active, sniper.hits || 0, sniper.fails || 0, sniper.lastFiredAt, sniper.createdAt || Date.now()]);
      return result.rowCount > 0;
    },
    async deleteSniper(userId, id) {
      const result = await pool.query('DELETE FROM snipers WHERE user_id=$1 AND id=$2', [userId, id]);
      return result.rowCount > 0;
    },
    async hasSeenTransaction(userId, sniperId, hash) {
      const result = await pool.query(
        'SELECT 1 FROM sniper_seen_transactions WHERE user_id=$1 AND sniper_id=$2 AND tx_hash=$3',
        [userId, sniperId, hash],
      );
      return result.rowCount > 0;
    },
    async markSeenTransaction(userId, sniperId, hash) {
      await pool.query(`INSERT INTO sniper_seen_transactions (user_id,sniper_id,tx_hash) VALUES ($1,$2,$3)
        ON CONFLICT DO NOTHING`, [userId, sniperId, hash]);
      await pool.query(`DELETE FROM sniper_seen_transactions WHERE user_id=$1 AND sniper_id=$2 AND tx_hash IN
        (SELECT tx_hash FROM sniper_seen_transactions WHERE user_id=$1 AND sniper_id=$2 ORDER BY seen_at DESC OFFSET 500)`,
      [userId, sniperId]);
    },
    close() { return pool.end(); },
  };
}

module.exports = { createPostgresStorage };
