const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// The palette is the one new surface in Phase 4 that sits next to every mutating flow in the app,
// so brief §2.2 makes it a HARD CONSTRAINT that it navigates only -- never mutates, never submits
// a form, never triggers a transaction. That constraint is invisible to the type system and easy
// to erode later ("just add a quick Create wallet action"), so it is asserted here against the
// source text, the same technique tests/chainGrouping.test.js already uses for EVM_CHAINS.
function paletteSource() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'src', 'App.jsx'), 'utf8');
  const start = source.indexOf('function CommandPalette(');
  assert.notEqual(start, -1, 'App.jsx must declare a CommandPalette component');
  const end = source.indexOf('const VIEWS=', start);
  assert.notEqual(end, -1, 'CommandPalette must be declared before the VIEWS map');
  return source.slice(start, end);
}

test('the command palette navigates only and can never mutate', () => {
  const body = paletteSource();
  for (const forbidden of ['api(', 'method:', "'POST'", "'PUT'", "'DELETE'", 'onSubmit', '<form']) {
    assert.equal(body.includes(forbidden), false,
      `CommandPalette must not contain ${forbidden} — brief §2.2 requires it to navigate only. ` +
      'Route to the page and let the user act there.');
  }
});

test('the palette indexes the Moved group, which is what makes the 11->5 merge safe', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'src', 'App.jsx'), 'utf8');
  const moved = source.slice(source.indexOf('const PALETTE_MOVED='), source.indexOf('const PALETTE_ACTIONS='));
  // Every retired page name must remain findable by its OLD name after the merge.
  for (const retired of ['Minting', 'Tasks', 'Snipers', 'Watch Rules', 'Target Policies', 'P&L', 'Activity']) {
    assert.ok(moved.includes(`'${retired}'`), `retired page ${retired} must stay findable in the palette's Moved group`);
  }
});

// Every retired slug and every retired in-app page name must resolve somewhere real, or a
// bookmark breaks and a go() call lands on /dashboard/undefined.
test('every retired slug and page alias resolves to a live page', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'src', 'App.jsx'), 'utf8');
  const slugs = source.slice(source.indexOf('const PAGE_SLUGS='), source.indexOf('const SLUG_PAGES='));
  const livePages = [...slugs.matchAll(/([A-Za-z&'\s]+):'/g)].map(match => match[1].replace(/^'|'$/g, '').trim());
  const retiredBlock = source.slice(source.indexOf('const RETIRED_SLUGS='), source.indexOf('const PAGE_ALIASES='));
  const aliasBlock = source.slice(source.indexOf('const PAGE_ALIASES='), source.indexOf('function pageFromLocation'));
  const targets = [...`${retiredBlock}${aliasBlock}`.matchAll(/page:'([^']+)'/g)].map(match => match[1]);
  assert.ok(targets.length >= 12, `expected every retired slug and alias to be covered, found ${targets.length}`);
  for (const target of targets) {
    assert.ok(livePages.includes(target), `redirect target "${target}" is not a live page in PAGE_SLUGS`);
  }
});
