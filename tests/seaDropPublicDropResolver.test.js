const assert = require('node:assert/strict');
const test = require('node:test');
const { createSeaDropPublicDropResolver } = require('../src/mint/seaDropPublicDropResolver');
const { SEADROP_CORE_INTERFACE } = require('../src/mint/seaDropRegistry');

const CONTRACT = '0x00000000000000000000000000000000000000C3';
const SEADROP = '0x00000000000000000000000000000000000000D4';

function providerServiceReturning(value) {
  return { perform: async (chain, name, operation) => operation({ call: async () => value }) };
}
function providerServiceThrowing() {
  return { perform: async () => { throw new Error('boom'); } };
}

test('getPublicDrop decodes a successful PublicDrop response', async () => {
  const encoded = SEADROP_CORE_INTERFACE.encodeFunctionResult('getPublicDrop', [[
    1_000_000_000_000_000n, 1_700_000_000, 1_800_000_000, 5, 250, true,
  ]]);
  const resolver = createSeaDropPublicDropResolver({ providerService: providerServiceReturning(encoded) });
  const drop = await resolver.getPublicDrop('ethereum', SEADROP, CONTRACT);
  assert.equal(drop.mintPriceWei, '1000000000000000');
  assert.equal(drop.startTime, 1_700_000_000);
  assert.equal(drop.endTime, 1_800_000_000);
  assert.equal(drop.maxTotalMintableByWallet, 5);
  assert.equal(drop.feeBps, 250);
  assert.equal(drop.restrictFeeRecipients, true);
});

test('getPublicDrop returns null (not a throw) when the call reverts', async () => {
  const resolver = createSeaDropPublicDropResolver({ providerService: providerServiceThrowing() });
  assert.equal(await resolver.getPublicDrop('ethereum', SEADROP, CONTRACT), null);
});

test('getAllowedFeeRecipients decodes an address array', async () => {
  const other = '0x00000000000000000000000000000000000000E5';
  const encoded = SEADROP_CORE_INTERFACE.encodeFunctionResult('getAllowedFeeRecipients', [[other]]);
  const resolver = createSeaDropPublicDropResolver({ providerService: providerServiceReturning(encoded) });
  const recipients = await resolver.getAllowedFeeRecipients('ethereum', SEADROP, CONTRACT);
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].toLowerCase(), other.toLowerCase());
});

test('getAllowedFeeRecipients returns an empty array (not a throw) when the call reverts', async () => {
  const resolver = createSeaDropPublicDropResolver({ providerService: providerServiceThrowing() });
  assert.deepEqual(await resolver.getAllowedFeeRecipients('ethereum', SEADROP, CONTRACT), []);
});
