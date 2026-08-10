const { Pool } = require('pg');

function createDatabasePool({ connectionString, max = 5 }) {
  if (!connectionString) throw new Error('DATABASE_URL is required to create the application database pool');
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  pool.on('error', () => console.error('Unexpected idle PostgreSQL connection error'));
  return pool;
}

module.exports = { createDatabasePool };
