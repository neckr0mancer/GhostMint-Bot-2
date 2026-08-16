const test = require('node:test');
const assert = require('node:assert/strict');
const { createPanelStore } = require('../src/telegram/panelState');

test('a chat with no panel yet has nothing to move', () => {
  const panels = createPanelStore();
  assert.deepEqual(panels.read(1), { anchor: null, newest: 0, at: 0 });
  assert.equal(panels.shouldMove(1), false);
});

test('the panel stays put while it is still the newest message in the chat', () => {
  const panels = createPanelStore();
  panels.noteAnchor(1, 100);
  assert.equal(panels.shouldMove(1), false, 'nothing has been sent below it yet');
});

test('an inbound user message below the panel forces it to move', () => {
  const panels = createPanelStore();
  panels.noteAnchor(1, 100);
  panels.noteIncoming(1, 101);
  assert.equal(panels.shouldMove(1), true,
    'editing here would update a bubble sitting above the user message, reading out of order');
});

test('deleting the message that displaced the panel lets it stay put again', () => {
  const panels = createPanelStore();
  panels.noteAnchor(1, 100);
  panels.noteIncoming(1, 101);
  panels.noteDeleted(1, 101);
  assert.equal(panels.shouldMove(1), false,
    'guided flows delete the reply they consume, so the panel should not chase a hidden message');
});

test('deleting some other message does not clear a still-displacing one', () => {
  const panels = createPanelStore();
  panels.noteAnchor(1, 100);
  panels.noteIncoming(1, 101);
  panels.noteIncoming(1, 102);
  panels.noteDeleted(1, 101);
  assert.equal(panels.shouldMove(1), true, '102 is still sitting below the panel');
});

test('re-anchoring after a move clears the displacement', () => {
  const panels = createPanelStore();
  panels.noteAnchor(1, 100);
  panels.noteIncoming(1, 101);
  assert.equal(panels.shouldMove(1), true);
  panels.noteAnchor(1, 102);
  assert.equal(panels.shouldMove(1), false, 'the fresh panel is now the newest message');
});

test('taking over an existing message as the panel counts it as seen', () => {
  const panels = createPanelStore();
  panels.noteAnchor(1, 500);
  const state = panels.read(1);
  assert.equal(state.newest, 500, 'the anchor is itself a message and cannot predate newest');
  assert.equal(panels.shouldMove(1), false);
});

test('chats are tracked independently', () => {
  const panels = createPanelStore();
  panels.noteAnchor(1, 100);
  panels.noteAnchor(2, 100);
  panels.noteIncoming(1, 101);
  assert.equal(panels.shouldMove(1), true);
  assert.equal(panels.shouldMove(2), false, 'one chat\'s traffic must not move another chat\'s panel');
});

test('ignores missing chat or message identifiers instead of recording a bogus entry', () => {
  const panels = createPanelStore();
  assert.equal(panels.noteAnchor(null, 1), null);
  assert.equal(panels.noteIncoming(1, null), null);
  assert.equal(panels.noteDeleted(null, null), null);
  assert.equal(panels.size(), 0);
});

test('entries that have aged out are pruned once the store grows large, not kept forever', () => {
  let clock = 1_000;
  const panels = createPanelStore({ ttlMs: 100, sweepThreshold: 3, now: () => clock });
  panels.noteAnchor(1, 10);
  panels.noteAnchor(2, 10);
  clock += 10_000;
  // Writing while at/over the threshold triggers the sweep, which drops the two stale chats.
  panels.noteAnchor(3, 10);
  assert.equal(panels.size(), 1, 'only the freshly written chat survives');
  assert.equal(panels.read(3).anchor, 10);
});

test('a busy chat below the sweep threshold is never pruned mid-conversation', () => {
  let clock = 1_000;
  const panels = createPanelStore({ ttlMs: 100, sweepThreshold: 50, now: () => clock });
  panels.noteAnchor(1, 10);
  clock += 10_000;
  panels.noteIncoming(1, 11);
  assert.equal(panels.shouldMove(1), true, 'still tracked despite being older than the TTL');
});
