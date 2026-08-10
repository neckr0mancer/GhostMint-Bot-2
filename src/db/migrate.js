const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

async function runMigrations({ connectionString, migrationsDirectory }) {
  if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED is required to run migrations');
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('ghostmint_schema_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const files = (await fs.readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();
    const applied = [];
    for (const filename of files) {
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
      if (exists.rowCount) continue;
      const sql = await fs.readFile(path.join(migrationsDirectory, filename), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        applied.push(filename);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return { applied, connection: 'unpooled' };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('ghostmint_schema_migrations'))").catch(() => {});
    await client.end();
  }
}

module.exports = { runMigrations };
