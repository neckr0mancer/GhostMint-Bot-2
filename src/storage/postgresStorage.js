function number(value) { return value === null ? null : Number(value); }
function time(value) { return value === null ? null : new Date(value).getTime(); }

function mapWallet(row) {
  return {
    id: Number(row.id), label: row.label, address: row.address, chain: row.chain,
    keyEnvelope: {
      ciphertext: row.encrypted_private_key,
      salt: row.encryption_salt,
      nonce: row.encryption_nonce,
      authTag: row.encryption_auth_tag,
      keyVersion: row.encryption_key_version,
    },
    minted: row.minted, addedAt: time(row.added_at),
  };
}

function mapTask(row) {
  return {
    id: Number(row.id), name: row.name, walletLabel: row.wallet_label,
    contract: row.contract_address, fn: row.function_name, qty: row.quantity,
    price: number(row.price_eth), gas: number(row.gas_gwei),
    mintTime: time(row.mint_time), status: row.status, createdAt: time(row.created_at),
  };
}

function mapActivity(row) {
  return {
    id: Number(row.id), status: row.status, title: row.title,
    walletLabel: row.wallet_label, txHash: row.tx_hash, explorer: row.explorer,
    time: time(row.occurred_at),
  };
}

function mapPnl(row) {
  return {
    id: Number(row.id), nm: row.name, cost: number(row.cost), sale: number(row.sale),
    gas: number(row.gas), net: number(row.net), t: time(row.created_at),
  };
}

function mapSniper(row) {
  return {
    id: Number(row.id), label: row.label, targetAddress: row.target_address,
    chain: row.chain, walletLabel: row.wallet_label, valueMode: row.value_mode,
    fixedValueETH: number(row.fixed_value_eth), maxValueETH: number(row.max_value_eth),
    gasBoostPercent: row.gas_boost_percent, active: row.active, hits: row.hits,
    fails: row.fails, lastFiredAt: time(row.last_fired_at), createdAt: time(row.created_at),
  };
}

function createPostgresStorage(pool) {
  return {
    async health() {
      const result = await pool.query('SELECT 1 AS connected');
      return result.rows[0]?.connected === 1;
    },

    async loadState() {
      const [wallets, tasks, activity, pnl, snipers] = await Promise.all([
        pool.query('SELECT * FROM wallets ORDER BY id'),
        pool.query('SELECT * FROM mint_tasks ORDER BY created_at'),
        pool.query('SELECT * FROM activity ORDER BY occurred_at DESC LIMIT 200'),
        pool.query('SELECT * FROM pnl_records ORDER BY created_at DESC'),
        pool.query('SELECT * FROM snipers ORDER BY created_at'),
      ]);
      return {
        wallets: wallets.rows.map(mapWallet), tasks: tasks.rows.map(mapTask),
        activity: activity.rows.map(mapActivity), pnl: pnl.rows.map(mapPnl),
        snipers: snipers.rows.map(mapSniper),
      };
    },

    async addWallet(wallet) {
      const e = wallet.keyEnvelope;
      const result = await pool.query(`
        INSERT INTO wallets (label, address, chain, encrypted_private_key, encryption_salt,
          encryption_nonce, encryption_auth_tag, encryption_key_version, minted, added_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TO_TIMESTAMP($10 / 1000.0)) RETURNING *`,
      [wallet.label, wallet.address, wallet.chain, e.ciphertext, e.salt, e.nonce, e.authTag,
        e.keyVersion, wallet.minted || 0, wallet.addedAt]);
      return mapWallet(result.rows[0]);
    },

    async deleteWallet(label) { await pool.query('DELETE FROM wallets WHERE label = $1', [label]); },
    async updateWalletMinted(label, minted) {
      await pool.query('UPDATE wallets SET minted = $2 WHERE label = $1', [label, minted]);
    },
    async updateWalletEnvelope(id, envelope) {
      await pool.query(`UPDATE wallets SET encrypted_private_key=$2, encryption_salt=$3,
        encryption_nonce=$4, encryption_auth_tag=$5, encryption_key_version=$6 WHERE id=$1`,
      [id, envelope.ciphertext, envelope.salt, envelope.nonce, envelope.authTag, envelope.keyVersion]);
    },

    async saveTask(task) {
      await pool.query(`INSERT INTO mint_tasks
        (id,name,wallet_label,contract_address,function_name,quantity,price_eth,gas_gwei,mint_time,status,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TO_TIMESTAMP($9 / 1000.0),$10,TO_TIMESTAMP($11 / 1000.0))
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,wallet_label=EXCLUDED.wallet_label,
        contract_address=EXCLUDED.contract_address,function_name=EXCLUDED.function_name,
        quantity=EXCLUDED.quantity,price_eth=EXCLUDED.price_eth,gas_gwei=EXCLUDED.gas_gwei,
        mint_time=EXCLUDED.mint_time,status=EXCLUDED.status`,
      [task.id, task.name, task.walletLabel, task.contract, task.fn || 'mint', task.qty,
        task.price || 0, task.gas ?? null, task.mintTime, task.status, task.createdAt || Date.now()]);
    },
    async deleteTask(id) { await pool.query('DELETE FROM mint_tasks WHERE id = $1', [id]); },

    async addActivity(entry) {
      const result = await pool.query(`INSERT INTO activity
        (status,title,wallet_label,tx_hash,explorer,occurred_at)
        VALUES ($1,$2,$3,$4,$5,TO_TIMESTAMP($6 / 1000.0)) RETURNING *`,
      [entry.status, entry.title, entry.walletLabel, entry.txHash, entry.explorer, entry.time]);
      return mapActivity(result.rows[0]);
    },

    async addPnl(record) {
      const result = await pool.query(`INSERT INTO pnl_records (name,cost,sale,gas,net,created_at)
        VALUES ($1,$2,$3,$4,$5,TO_TIMESTAMP($6 / 1000.0)) RETURNING *`,
      [record.nm, record.cost, record.sale, record.gas, record.net, record.t]);
      return mapPnl(result.rows[0]);
    },
    async deletePnl(id) { await pool.query('DELETE FROM pnl_records WHERE id = $1', [id]); },

    async saveSniper(sniper) {
      await pool.query(`INSERT INTO snipers
        (id,label,target_address,chain,wallet_label,value_mode,fixed_value_eth,max_value_eth,
          gas_boost_percent,active,hits,fails,last_fired_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          CASE WHEN $13::BIGINT IS NULL THEN NULL ELSE TO_TIMESTAMP($13 / 1000.0) END,
          TO_TIMESTAMP($14 / 1000.0))
        ON CONFLICT (id) DO UPDATE SET label=EXCLUDED.label,target_address=EXCLUDED.target_address,
        chain=EXCLUDED.chain,wallet_label=EXCLUDED.wallet_label,value_mode=EXCLUDED.value_mode,
        fixed_value_eth=EXCLUDED.fixed_value_eth,max_value_eth=EXCLUDED.max_value_eth,
        gas_boost_percent=EXCLUDED.gas_boost_percent,active=EXCLUDED.active,hits=EXCLUDED.hits,
        fails=EXCLUDED.fails,last_fired_at=EXCLUDED.last_fired_at`,
      [sniper.id, sniper.label, sniper.targetAddress, sniper.chain, sniper.walletLabel,
        sniper.valueMode, sniper.fixedValueETH || 0, sniper.maxValueETH, sniper.gasBoostPercent,
        sniper.active, sniper.hits || 0, sniper.fails || 0, sniper.lastFiredAt,
        sniper.createdAt || Date.now()]);
    },
    async deleteSniper(id) { await pool.query('DELETE FROM snipers WHERE id = $1', [id]); },
    async hasSeenTransaction(sniperId, hash) {
      const result = await pool.query('SELECT 1 FROM sniper_seen_transactions WHERE sniper_id=$1 AND tx_hash=$2', [sniperId, hash]);
      return result.rowCount > 0;
    },
    async markSeenTransaction(sniperId, hash) {
      await pool.query(`INSERT INTO sniper_seen_transactions (sniper_id,tx_hash) VALUES ($1,$2)
        ON CONFLICT DO NOTHING`, [sniperId, hash]);
      await pool.query(`DELETE FROM sniper_seen_transactions WHERE sniper_id=$1 AND tx_hash IN
        (SELECT tx_hash FROM sniper_seen_transactions WHERE sniper_id=$1 ORDER BY seen_at DESC OFFSET 500)`, [sniperId]);
    },
    close() { return pool.end(); },
  };
}

module.exports = { createPostgresStorage };
