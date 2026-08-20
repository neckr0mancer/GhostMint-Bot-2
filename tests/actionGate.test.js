const assert = require('node:assert/strict');
const test = require('node:test');
const { createActionGate, requiresPassword, normaliseLevel, GateLockedError } = require('../src/security/actionGate');

// The gate ships OFF. Most of what these tests protect is that fact: an account that never opts in
// must behave exactly as it did before the gate existed, because a gate that switched itself on
// would lock people out of their own wallets with no warning and no way to reach the dashboard.

function fixture({ level = 'off', hash = 'stored-hash', password = 'correct-horse-battery', ...rest } = {}) {
  let clock = 1_000_000;
  const gate = createActionGate({
    getLevel: async () => level,
    getPasswordHash: async () => hash,
    verify: (supplied, stored) => stored === 'stored-hash' && supplied === password,
    now: () => clock,
    ...rest,
  });
  return { gate, advance: ms => { clock += ms; }, at: () => clock };
}

test('with the gate off, every action proceeds exactly as before -- nothing is asked for', async () => {
  const { gate } = fixture({ level: 'off' });
  for (const action of ['exportkey', 'removewallet', 'send', 'walletlist', 'balance']) {
    assert.equal(await gate.allows('user-a', 'telegram', 'chat-1', action), true, `${action} must be ungated`);
  }
});

test('sensitive level gates the irreversible actions but leaves read-only ones alone', () => {
  assert.equal(requiresPassword('sensitive', 'exportkey'), true);
  assert.equal(requiresPassword('sensitive', 'removewallet'), true);
  assert.equal(requiresPassword('sensitive', 'send'), true);
  assert.equal(requiresPassword('sensitive', 'balance'), false, 'reading a balance is not irreversible');
  assert.equal(requiresPassword('sensitive', 'walletlist'), false);
});

test('strict level additionally gates the read-only surfaces that disclose holdings', () => {
  assert.equal(requiresPassword('strict', 'balance'), true);
  assert.equal(requiresPassword('strict', 'walletlist'), true);
  assert.equal(requiresPassword('strict', 'exportkey'), true, 'strict is a superset of sensitive');
});

test('an action nobody classified is ungated at every level, so a gap fails open to old behaviour', () => {
  // A missing entry must never lock someone out of something that used to work; the cost of the
  // opposite mistake is far higher than the cost of this one.
  for (const level of ['off', 'sensitive', 'strict']) {
    assert.equal(requiresPassword(level, 'some-future-command'), false);
  }
});

test('an unrecognised or absent level is treated as off rather than as something stricter', () => {
  assert.equal(normaliseLevel(undefined), 'off');
  assert.equal(normaliseLevel(null), 'off');
  assert.equal(normaliseLevel('SENSITIVE'), 'sensitive', 'case is normalised, not rejected');
  assert.equal(normaliseLevel('paranoid'), 'off', 'an unknown value must not gate anything');
});

test('the right password unlocks that conversation, and only for as long as it should', async () => {
  const { gate, advance } = fixture({ level: 'sensitive', unlockMs: 10 * 60 * 1000 });
  assert.equal(await gate.allows('user-a', 'telegram', 'chat-1', 'exportkey'), false, 'locked to begin with');

  const bad = await gate.submit('user-a', 'telegram', 'chat-1', 'wrong');
  assert.equal(bad.ok, false);
  assert.equal(await gate.allows('user-a', 'telegram', 'chat-1', 'exportkey'), false, 'a wrong password unlocks nothing');

  const good = await gate.submit('user-a', 'telegram', 'chat-1', 'correct-horse-battery');
  assert.equal(good.ok, true);
  assert.equal(await gate.allows('user-a', 'telegram', 'chat-1', 'exportkey'), true);

  advance(9 * 60 * 1000);
  assert.equal(await gate.allows('user-a', 'telegram', 'chat-1', 'exportkey'), true, 'still inside the window');
  advance(2 * 60 * 1000);
  assert.equal(await gate.allows('user-a', 'telegram', 'chat-1', 'exportkey'), false, 'the window closes on its own');
});

test('unlocking one conversation never unlocks another', async () => {
  // The point of keying on the conversation: a phone in a pocket must not silently unlock a
  // session someone else is looking at.
  const { gate } = fixture({ level: 'sensitive' });
  await gate.submit('user-a', 'telegram', 'chat-1', 'correct-horse-battery');
  assert.equal(await gate.allows('user-a', 'telegram', 'chat-1', 'exportkey'), true);
  assert.equal(await gate.allows('user-a', 'telegram', 'chat-2', 'exportkey'), false, 'a different chat');
  assert.equal(await gate.allows('user-a', 'discord', 'chat-1', 'exportkey'), false, 'a different platform');
});

test('lock() ends the window immediately, so /lock actually locks', async () => {
  const { gate } = fixture({ level: 'sensitive' });
  await gate.submit('user-a', 'telegram', 'chat-1', 'correct-horse-battery');
  assert.equal(gate.isUnlocked('telegram', 'chat-1'), true);
  gate.lock('telegram', 'chat-1');
  assert.equal(gate.isUnlocked('telegram', 'chat-1'), false);
  assert.equal(await gate.allows('user-a', 'telegram', 'chat-1', 'exportkey'), false);
});

test('repeated wrong passwords lock the conversation out, then recover on their own', async () => {
  const { gate, advance } = fixture({ level: 'sensitive', maxAttempts: 3, lockoutMs: 15 * 60 * 1000 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await gate.submit('user-a', 'telegram', 'chat-1', 'wrong');
    assert.equal(result.ok, false);
    assert.equal(result.attemptsLeft, 2 - attempt, 'the user is told how many tries remain');
  }
  await gate.submit('user-a', 'telegram', 'chat-1', 'wrong');
  await assert.rejects(() => gate.submit('user-a', 'telegram', 'chat-1', 'correct-horse-battery'),
    error => {
      assert.ok(error instanceof GateLockedError);
      assert.ok(error.retryAfterMs > 0, 'the caller can say how long to wait');
      return true;
    }, 'even the CORRECT password is refused while locked out -- otherwise the lockout is decorative');

  advance(16 * 60 * 1000);
  const after = await gate.submit('user-a', 'telegram', 'chat-1', 'correct-horse-battery');
  assert.equal(after.ok, true, 'the lockout expires rather than being permanent');
});

test('an account with no password set is refused clearly, never silently allowed', async () => {
  // Setting a password from chat would put it in message history forever, which is the exposure
  // the gate exists to reduce -- so the only answer here is "go set it on the dashboard".
  const { gate } = fixture({ level: 'sensitive', hash: null });
  await assert.rejects(() => gate.submit('user-a', 'telegram', 'chat-1', 'anything'),
    error => {
      assert.ok(error instanceof GateLockedError);
      assert.match(error.message, /no password set/);
      return true;
    });
  assert.equal(await gate.allows('user-a', 'telegram', 'chat-1', 'exportkey'), false,
    'and the action stays blocked rather than failing open');
});

test('a successful unlock clears the failure count, so old misses cannot accumulate into a lockout', async () => {
  const { gate } = fixture({ level: 'sensitive', maxAttempts: 3 });
  await gate.submit('user-a', 'telegram', 'chat-1', 'wrong');
  await gate.submit('user-a', 'telegram', 'chat-1', 'wrong');
  await gate.submit('user-a', 'telegram', 'chat-1', 'correct-horse-battery');
  gate.lock('telegram', 'chat-1');
  const result = await gate.submit('user-a', 'telegram', 'chat-1', 'wrong');
  assert.equal(result.attemptsLeft, 2, 'the counter restarted from the successful unlock');
});

// ACTION_TIERS shipped declaring eight actions while only four call sites actually consulted the
// gate -- so `strict` gated nothing that `sensitive` did not, and the extra tier was decorative.
// A tier table is a promise about behaviour; this checks the promise is kept by real call sites.
// Source-scanning rather than behavioural because the bot handlers are not individually exported.
test('every action the tier table classifies is actually consulted somewhere in the bots', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ACTION_TIERS } = require('../src/security/actionGate');
  const read = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
  const telegram = read('server.js');
  const discord = read(path.join('discord', 'discordBot.js'));

  // Actions Discord has no flow for at all, so there is nothing there to gate. linkcode is the
  // notable one: Discord can CONSUME a link code (link:enter) but cannot generate one, and it is
  // generation that hands over the account. If Discord ever grows a generate path it must be
  // gated on arrival -- this exemption is about a missing feature, not an accepted risk.
  const DISCORD_HAS_NO_FLOW = new Set(['exportkey', 'send', 'linkcode']);

  for (const action of Object.keys(ACTION_TIERS)) {
    assert.ok(telegram.includes(`action: '${action}'`),
      `${action} is classified in ACTION_TIERS but no Telegram call site asks the gate about it`);
    if (DISCORD_HAS_NO_FLOW.has(action)) continue;
    assert.ok(discord.includes(`platformUserId, '${action}'`),
      `${action} is classified in ACTION_TIERS but no Discord call site asks the gate about it`);
  }
});

test('strict genuinely gates more than sensitive, rather than being a decorative third option', () => {
  const { requiresPassword, ACTION_TIERS } = require('../src/security/actionGate');
  const gatedAt = level => Object.keys(ACTION_TIERS).filter(action => requiresPassword(level, action));
  const sensitive = gatedAt('sensitive');
  const strict = gatedAt('strict');
  assert.ok(gatedAt('off').length === 0, 'off gates nothing');
  assert.ok(strict.length > sensitive.length, 'strict must cover strictly more than sensitive');
  for (const action of sensitive) {
    assert.ok(strict.includes(action), `strict must be a superset -- ${action} is missing from it`);
  }
});

// A relock used to be silent. That is not a cosmetic gap: with one unlock covering every gated
// action in a conversation, a silent expiry means the owner cannot tell a gated action from an
// already-unlocked one, which is exactly how the first round of live testing produced a false pass.
test('the owner is told when the unlock window expires on its own', () => {
  const notices = [];
  let clock = 0;
  const pending = [];
  const gate = createActionGate({
    getLevel: async () => 'sensitive',
    getPasswordHash: async () => 'stored-hash',
    verify: () => true,
    now: () => clock,
    unlockMs: 600_000,
    onRelock: (platform, contextId, reason) => notices.push({ platform, contextId, reason }),
    setTimer: (fn, ms) => { pending.push({ fn, at: clock + ms }); return { unref() {} }; },
    clearTimer: () => {},
  });
  gate.unlock('telegram', 'chat-1');
  assert.deepEqual(notices, [], 'nothing is announced while the window is still open');

  clock = 600_000;
  pending.forEach(timer => timer.fn());
  assert.deepEqual(notices, [{ platform: 'telegram', contextId: 'chat-1', reason: 'expired' }]);
});

test('locking on purpose reports it, and reports doing nothing when already locked', () => {
  const notices = [];
  const gate = createActionGate({
    getLevel: async () => 'sensitive',
    getPasswordHash: async () => 'stored-hash',
    verify: () => true,
    onRelock: (platform, contextId, reason) => notices.push(reason),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  gate.unlock('telegram', 'chat-1');
  assert.equal(gate.lock('telegram', 'chat-1', { notify: true }), true, 'reports that it locked something');
  assert.deepEqual(notices, ['locked']);
  assert.equal(gate.lock('telegram', 'chat-1', { notify: true }), false,
    'a second lock reports that nothing was unlocked, rather than claiming success');
  assert.deepEqual(notices, ['locked'], 'and does not announce a relock that did not happen');
});

test('an expiry notice that throws can never break the gate', () => {
  const pending = [];
  const gate = createActionGate({
    getLevel: async () => 'sensitive',
    getPasswordHash: async () => 'stored-hash',
    verify: () => true,
    onRelock: () => { throw new Error('telegram is down'); },
    setTimer: fn => { pending.push(fn); return { unref() {} }; },
    clearTimer: () => {},
  });
  gate.unlock('telegram', 'chat-1');
  assert.doesNotThrow(() => pending.forEach(fn => fn()));
  assert.equal(gate.isUnlocked('telegram', 'chat-1'), false, 'and the window still closed');
});

test('link code generation is gated at sensitive -- it hands over the whole account', () => {
  // A link code is redeemable on the dashboard, so generating one lets a stranger sign in AS the
  // owner. Gating key export while leaving this open would be locking the door and posting the key
  // through the letterbox.
  assert.equal(requiresPassword('sensitive', 'linkcode'), true);
  assert.equal(requiresPassword('strict', 'linkcode'), true);
  assert.equal(requiresPassword('off', 'linkcode'), false, 'still nothing happens while off');
});

test('strict covers the surfaces that merely disclose, sensitive covers the ones that cost', () => {
  for (const action of ['exportkey', 'send', 'removewallet', 'linkcode', 'mode', 'admin', 'watchedit']) {
    assert.equal(requiresPassword('sensitive', action), true, `${action} can cost money or the account`);
  }
  for (const action of ['walletlist', 'balance', 'activity', 'snipers', 'watchrules', 'settings', 'tasks']) {
    assert.equal(requiresPassword('sensitive', action), false, `${action} only discloses, so sensitive leaves it`);
    assert.equal(requiresPassword('strict', action), true, `${action} must be covered by strict`);
  }
});
