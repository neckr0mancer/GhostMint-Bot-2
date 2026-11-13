const assert = require('node:assert/strict');
const test = require('node:test');
const { createBotSecurityRepository } = require('../src/security/botSecurityRepository');

function auditRow(id = 'audit-1') {
  return {
    audit_id: id, user_id: 'user-1', platform: 'dashboard', platform_user_id: null,
    context_id: 'session-1', command_name: 'admin:ban', outcome: 'success',
    reason: 'governance write completed', attempted_at: new Date('2026-10-18T10:00:00Z'),
  };
}

test('owner audit page filters in PostgreSQL and returns real pagination metadata', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('COUNT(*)')) return { rows: [{ total: 31 }] };
    return { rows: [auditRow()] };
  } };
  const repository = createBotSecurityRepository(pool);
  const page = await repository.listPage({ page: '2', pageSize: '10', search: 'mint', outcome: 'denied' });

  assert.deepEqual({ page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages },
    { page: 2, pageSize: 10, total: 31, totalPages: 4 });
  assert.equal(page.items[0].command, 'admin:ban');
  assert.match(calls[0].sql, /outcome IN \('failure','rejected','unauthorized','denied'\)/);
  assert.match(calls[0].sql, /command_name ILIKE \$1/);
  assert.deepEqual(calls[0].params, ['%mint%']);
  assert.match(calls[1].sql, /ORDER BY attempted_at DESC, audit_id DESC LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(calls[1].params, ['%mint%', 10, 10]);
});

test('audit pagination clamps page size and an out-of-range page without losing account scope', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('COUNT(*)')) return { rows: [{ total: '3' }] };
    return { rows: [auditRow('audit-2')] };
  } };
  const repository = createBotSecurityRepository(pool);
  const page = await repository.listPage({ page: '99', pageSize: '1000', outcome: 'rate_limited', userId: 'user-1' });

  assert.equal(page.page, 1);
  assert.equal(page.pageSize, 100);
  assert.equal(page.totalPages, 1);
  assert.match(calls[0].sql, /user_id=\$1/);
  assert.match(calls[0].sql, /outcome=\$2/);
  assert.deepEqual(calls[0].params, ['user-1', 'rate_limited']);
  assert.deepEqual(calls[1].params, ['user-1', 'rate_limited', 100, 0]);
});
