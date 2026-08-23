const assert = require('node:assert/strict');
const test = require('node:test');
const { createLauncher } = require('../src/launch/launcher');

// A launcher wired against in-memory fakes: the repository is a Map-backed stub mirroring the
// postgres surface, mintService.prepare just echoes the plan, and "execution" records the order
// sends went out. The point is orchestration semantics -- waves all fire, failures never abort
// siblings, and settlement converges to a report card via the restart-safe sweep.
function fixture({ failLabels = [], settleStates = {} } = {}) {
  const sent = [];
  let idCounter = 0;
  const squads = new Map();
  const intents = new Map();
  const repo = {
    async createSquad(squad) {
      squads.set(squad.id, { ...squad, members: squad.members.map(m => ({ status: 'pending', ...m })) });
    },
    async getSquad(userId, id) { return squads.get(id); },
    async getSquadById(id) { return squads.get(id); },
    // Mirror of the real atomic claim: first caller wins, later ones get nothing.
    async claimForFire(id) {
      const squad = squads.get(id);
      if (!squad || !['staged', 'armed'].includes(squad.status)) return false;
      squad.status = 'firing';
      return true;
    },
    async updateSquad(id, fields) {
      const squad = squads.get(id);
      Object.assign(squad, fields, { firedAt: fields.firedAt instanceof Date ? fields.firedAt.getTime() : squad.firedAt });
    },
    async updateMemberStatus(squadId, label, fields) {
      const squad = squads.get(squadId);
      const member = squad.members.find(m => (m.walletLabel ?? m.label) === label);
      Object.assign(member, fields, {
        sentAt: fields.sentAt instanceof Date ? fields.sentAt.getTime() : member.sentAt,
        confirmedAt: fields.confirmedAt instanceof Date ? fields.confirmedAt.getTime() : member.confirmedAt,
      });
    },
    async listDueTimerSquads() { return []; },
    async listFiringSquads() { return [...squads.values()].filter(s => s.status === 'firing'); },
  };
  const events = [];
  const launcher = createLauncher({
    repository: repo,
    stager: { stageSquad: async ({ members }) => ({
      plan: { methodSignature: 'mint(uint256)', priceWei: 0n, seaDropAddress: null, feeRecipient: null },
      results: members.map(m => ({ label: m.label ?? m, priority: 100,
        status: m.status === 'skipped' ? 'skipped' : 'staged', error: m.error })) }) },
    mintExecution: {
      executePrepared: async ({ wallet, onIntentPersisted }) => {
        sent.push(wallet.label);
        if (failLabels.includes(wallet.label)) throw new Error(`send failed for ${wallet.label}`);
        const intentId = `intent-${++idCounter}`;
        intents.set(intentId, { intentId, state: 'pending' });
        onIntentPersisted?.({ intentId, txHash: `0xtx-${intentId}` });
        return { intentId, txHash: `0xtx-${intentId}`, state: 'pending' };
      },
    },
    mintService: { prepare: async input => ({ chain: 'base', valueWei: input.valueWei,
      preview: { contractAddress: input.contractAddress }, method: { signature: input.methodSignature }, calldata: '0x' }) },
    transactionEngine: {
      reconcileIntent: async current => {
        const next = settleStates[current.intentId] || 'confirmed';
        intents.set(current.intentId, { ...current, state: next });
        return { ...current, state: next };
      },
    },
    intentRepository: { get: async id => intents.get(id) },
    findWallet: (userId, label) => ({ address: `0x${label}`, label, chain: 'base' }),
    notify: event => events.push(event),
    log: () => {},
    now: () => Date.now(),
  });
  return { launcher, repo, squads, sent, events };
}

test('firing sends every staged member, tolerates individual failures, and skips staged-out wallets', async t => {
  await t.test('all members fire even when one send throws mid-wave; failures land in DB', async () => {
    const { launcher, squads, sent } = fixture({ failLabels: ['b'] });
    await launcher.createAndStage({ userId: 'u1', name: 'test', chain: 'base', contractAddress: '0xnft',
      quantity: 1, manualPriceWei: '0', wallets: ['a', 'b', 'c'] });
    const squad = [...squads.values()][0];
    await launcher.fire(squad);
    assert.deepEqual(sent.sort(), ['a', 'b', 'c'].sort(), 'one failure must not abort the wave');
    const byLabel = Object.fromEntries(squads.get(squad.id).members.map(m => [(m.walletLabel ?? m.label), m]));
    assert.equal(byLabel.b.status, 'failed');
    assert.match(byLabel.b.error, /send failed for b/);
    assert.equal(byLabel.a.status, 'sent');
  });

  await t.test('the settlement sweep reconciles intents and writes the report card', async () => {
    const { launcher, squads, events } = fixture({
      settleStates: { 'intent-2': 'reverted' },
    });
    await launcher.createAndStage({ userId: 'u1', name: 'test2', chain: 'base', contractAddress: '0xnft',
      quantity: 1, manualPriceWei: '0', wallets: ['a', 'b'] });
    const squad = [...squads.values()][0];
    await launcher.fire(squad);
    await launcher.settleFiringSquads();
    const fresh = squads.get(squad.id);
    assert.equal(fresh.status, 'done');
    const byLabel = Object.fromEntries(fresh.members.map(m => [(m.walletLabel ?? m.label), m]));
    assert.equal(byLabel.a.status, 'confirmed');
    assert.equal(byLabel.b.status, 'reverted');
    assert.equal(fresh.report.counts.confirmed, 1);
    assert.equal(fresh.report.counts.reverted, 1);
    assert.ok(events.some(e => e.type === 'launch.done'));
  });

  await t.test('a wallet staging marked skipped is persisted as skipped and never fired', async () => {
    const sent = [];
    const events = [];
    const squads = new Map();
    const repo = {
      async createSquad(squad) { squads.set(squad.id, { ...squad, members: squad.members.map(m => ({ status: 'pending', ...m })) }); },
      async getSquad(userId, id) { return squads.get(id); },
      async getSquadById(id) { return squads.get(id); },
      async claimForFire(id) {
        const s = squads.get(id);
        if (!s || !['staged', 'armed'].includes(s.status)) return false;
        s.status = 'firing';
        return true;
      },
      async updateSquad(id, fields) { Object.assign(squads.get(id), fields); },
      async updateMemberStatus(squadId, label, fields) {
        Object.assign(squads.get(squadId).members.find(m => (m.walletLabel ?? m.label) === label), fields);
      },
      async listDueTimerSquads() { return []; },
      async listFiringSquads() { return [...squads.values()].filter(s => s.status === 'firing'); },
    };
    const launcher = createLauncher({
      repository: repo,
      stager: { stageSquad: async ({ members }) => ({
        plan: { methodSignature: 'mint(uint256)', priceWei: 0n, seaDropAddress: null, feeRecipient: null },
        results: members.map(m => m.label === 'poor'
          ? { label: m.label, status: 'skipped', error: 'balance too low' }
          : { label: m.label, status: 'staged' }) }) },
      mintExecution: { executePrepared: async ({ wallet }) => { sent.push(wallet.label);
        return { intentId: `i-${wallet.label}`, txHash: '0xtx' }; } },
      mintService: { prepare: async input => ({ chain: 'base', valueWei: input.valueWei,
        preview: { contractAddress: input.contractAddress }, method: { signature: 'mint(uint256)' }, calldata: '0x' }) },
      transactionEngine: { reconcileIntent: async i => ({ ...i, state: 'confirmed' }) },
      intentRepository: { get: async id => ({ intentId: id, state: 'confirmed' }) },
      findWallet: (userId, label) => ({ address: `0x${label}`, label, chain: 'base' }),
      notify: e => events.push(e),
      log: () => {},
      now: () => Date.now(),
    });

    await launcher.createAndStage({ userId: 'u1', name: 'skip-test', chain: 'base', contractAddress: '0xnft',
      quantity: 1, manualPriceWei: '0', wallets: ['rich', 'poor'] });
    const squad = [...squads.values()][0];
    const byLabel = Object.fromEntries(squad.members.map(m => [(m.walletLabel ?? m.label), m]));
    assert.equal(byLabel.poor.status, 'skipped', 'the staging verdict must persist');
    assert.equal(byLabel.poor.error, 'balance too low');

    await launcher.fire(squad);
    assert.deepEqual(sent, ['rich'], 'the skipped wallet must never be fired');
    await launcher.settleFiringSquads();
    assert.equal(squads.get(squad.id).status, 'done');
    assert.ok(events.some(e => e.type === 'launch.done'));
  });

  await t.test('waves chunk by waveSize but every wave still goes out', async () => {
    const { launcher, squads, sent } = fixture();
    await launcher.createAndStage({ userId: 'u1', name: 'big', chain: 'base', contractAddress: '0xnft',
      quantity: 1, manualPriceWei: '0', wallets: Array.from({ length: 7 }, (_, i) => `w${i}`), maxWaveSize: 3 });
    const squad = [...squads.values()][0];
    const result = await launcher.fire(squad);
    assert.equal(result.fired, 7);
    assert.equal(sent.length, 7);
  });

  await t.test('a second fire of the same squad is refused -- exactly one caller ever launches it', async () => {
    const { launcher, squads, sent } = fixture();
    await launcher.createAndStage({ userId: 'u1', name: 'race', chain: 'base', contractAddress: '0xnft',
      quantity: 1, manualPriceWei: '0', wallets: ['a', 'b'] });
    const squad = [...squads.values()][0];
    const first = await launcher.fire(squad);
    const second = await launcher.fire(squad);
    assert.ok(first, 'the winning caller proceeds');
    assert.equal(second, null, 'the losing caller must be told another launch already started');
    assert.equal(sent.length, 2, 'members must not be sent twice');
  });
});
