const assert = require('node:assert/strict');
const test = require('node:test');
const { createLauncher } = require('../src/launch/launcher');

// A launcher wired against in-memory fakes: the repository is a Map-backed stub mirroring the
// postgres surface, mintService.prepare just echoes the plan, and "execution" records the order
// sends went out. The point is orchestration semantics -- waves all fire, failures never abort
// siblings, settlement converges to a report card.
function fixture({ members = ['w1', 'w2', 'w3'], failLabels = [], settleStates = {} } = {}) {
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
  };
  const launcher = createLauncher({
    repository: repo,
    stager: { stageSquad: async ({ members }) => ({
      plan: { methodSignature: 'mint(uint256)', priceWei: 0n, seaDropAddress: null, feeRecipient: null },
      results: members.map(m => ({ label: m.label, priority: 100, status: 'staged' })) }) },
    mintExecution: {
      executePrepared: async ({ wallet, idempotencyKey, onIntentPersisted }) => {
        sent.push(wallet.label);
        if (failLabels.includes(wallet.label)) throw new Error(`send failed for ${wallet.label}`);
        const intentId = `intent-${++idCounter}`;
        intents.set(intentId, { intentId, state: 'pending' });
        onIntentPersisted?.({ intentId, txHash: `0xtx-${intentId}` });
        return { intentId, txHash: `0xtx-${intentId}`, state: 'pending' };
      },
    },
    mintService: { prepare: async input => ({ echo: input, chain: 'base', valueWei: input.valueWei,
      preview: { contractAddress: input.contractAddress }, method: { signature: input.methodSignature }, calldata: '0x' }) },
    transactionEngine: {
      reconcileIntent: async intent => {
        const next = settleStates[intent.intentId] || 'confirmed';
        intents.set(intent.intentId, { ...intent, state: next });
        return { ...intent, state: next };
      },
    },
    intentRepository: { get: async id => intents.get(id) },
    findWallet: (userId, label) => ({ address: `0x${label}`, label, chain: 'base' }),
    notify: event => events.push(event),
    log: () => {},
    now: () => Date.now(),
    settleIntervalMs: 1,
  });
  const events = [];
  return { launcher, repo, squads, sent, events };
}

test('firing sends every staged member, tolerates individual failures, and settles a report card', async t => {
  await t.test('all members fire even when one send throws mid-wave', async () => {
    const { launcher, squads, sent } = fixture({ members: ['a', 'b', 'c'], failLabels: ['b'] });
    await launcher.createAndStage({ userId: 'u1', name: 'test', chain: 'base', contractAddress: '0xnft',
      quantity: 1, manualPriceWei: '0', wallets: ['a', 'b', 'c'] });
    const squad = [...squads.values()][0];
    const outcomes = await launcher.fire(squad);
    assert.deepEqual(sent.sort(), ['a', 'b', 'c'].sort(), 'one failure must not abort the wave');
    assert.equal(outcomes.filter(o => !o.ok).length, 1);
  });

  await t.test('settlement reconciles intents and writes the report card', async () => {
    const { launcher, squads, events } = fixture({
      members: ['a', 'b'],
      settleStates: { 'intent-2': 'reverted' },
    });
    await launcher.createAndStage({ userId: 'u1', name: 'test2', chain: 'base', contractAddress: '0xnft',
      quantity: 1, manualPriceWei: '0', wallets: ['a', 'b'] });
    const squad = [...squads.values()][0];
    await launcher.fire(squad);
    await new Promise(resolve => setTimeout(resolve, 30));
    const fresh = squads.get(squad.id);
    assert.equal(fresh.status, 'done');
    const byLabel = Object.fromEntries(fresh.members.map(m => [(m.walletLabel ?? m.label), m]));
    assert.equal(byLabel.a.status, 'confirmed');
    assert.equal(byLabel.b.status, 'reverted');
    assert.equal(fresh.report.counts.confirmed, 1);
    assert.equal(fresh.report.counts.reverted, 1);
    assert.ok(events.some(e => e.type === 'launch.done'));
  });

  await t.test('waves chunk by waveSize but every wave still goes out', async () => {
    const { launcher, squads, sent } = fixture({ members: [] });
    await launcher.createAndStage({ userId: 'u1', name: 'big', chain: 'base', contractAddress: '0xnft',
      quantity: 1, manualPriceWei: '0', wallets: Array.from({ length: 7 }, (_, i) => `w${i}`), maxWaveSize: 3 });
    const squad = [...squads.values()][0];
    await launcher.fire(squad);
    assert.equal(sent.length, 7);
  });

  await t.test('a second fire of the same squad is refused -- exactly one caller ever launches it', async () => {
    const { launcher, squads, sent } = fixture({ members: ['a', 'b'] });
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
