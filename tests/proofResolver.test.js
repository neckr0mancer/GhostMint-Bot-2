const assert = require('node:assert/strict');
const test = require('node:test');
const { URL } = require('node:url');
const { ProofResolutionError, createProofResolver } = require('../src/mint/proofResolver');

const WALLET = '0x00000000000000000000000000000000000000A1';
const NODE = `0x${'cd'.repeat(32)}`;

test('automatic proof fetching supplies the wallet address and parses a valid response', async () => {
  let requestedUrl;
  const resolver = createProofResolver({ fetchJson: async url => {
    requestedUrl = url;
    return { data: { proof: [NODE] } };
  } });
  const args = await resolver.resolve({ methodSignature: 'mint(uint256,bytes32[])', arguments: [2],
    proofUrl: 'https://allowlist.example/api', walletAddress: WALLET });
  assert.deepEqual(args, [2, [NODE]]);
  assert.equal(new URL(requestedUrl).searchParams.get('address'), WALLET);
});

test('IPFS and address-keyed allowlist responses are supported', async () => {
  const resolver = createProofResolver({ fetchJson: async url => {
    assert.match(url, /^https:\/\/gateway\.example\/ipfs\/cid/);
    return { data: { [WALLET.toLowerCase()]: [NODE] } };
  }, ipfsGateway: 'https://gateway.example/ipfs/' });
  assert.deepEqual(await resolver.resolve({ methodSignature: 'mint(uint256,bytes32[])', arguments: [1],
    proofUrl: 'ipfs://cid/proofs.json', walletAddress: WALLET }), [1, [NODE]]);
});

test('failed or malformed automatic proof fetch requires manual entry and never returns empty authorization', async t => {
  await t.test('network failure', async () => {
    const resolver = createProofResolver({ fetchJson: async () => { throw new Error('offline'); } });
    await assert.rejects(resolver.resolve({ methodSignature: 'mint(uint256,bytes32[])', arguments: [1],
      proofUrl: 'https://allowlist.example/api', walletAddress: WALLET }), error =>
      error instanceof ProofResolutionError && error.code === 'MANUAL_AUTHORIZATION_REQUIRED' && /manually/.test(error.message));
  });
  await t.test('malformed response', async () => {
    const resolver = createProofResolver({ fetchJson: async () => ({ data: { proof: [] } }) });
    await assert.rejects(resolver.resolve({ methodSignature: 'mint(uint256,bytes32[])', arguments: [1],
      proofUrl: 'https://allowlist.example/api', walletAddress: WALLET }), ProofResolutionError);
  });
});

test('uploaded manual proof JSON is parsed without a network call', async () => {
  const resolver = createProofResolver({ fetchJson: async () => { throw new Error('must not fetch'); } });
  assert.deepEqual(await resolver.resolve({ methodSignature: 'mint(uint256,bytes32[])', arguments: [1],
    manualAuthorization: JSON.stringify([NODE]), walletAddress: WALLET }), [1, [NODE]]);
});
