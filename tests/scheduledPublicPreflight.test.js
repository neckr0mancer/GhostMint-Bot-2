const assert = require('node:assert/strict');
const test = require('node:test');
const { liveFeeRecipient, opaquePublicSimulationReason, publicMintCapacity,
  publicStageClock } = require('../src/scheduler/scheduledPublicPreflight');

const WALLET = '0x00000000000000000000000000000000000000A1';
const OLD_FEE = '0x00000000000000000000000000000000000000B1';
const NEW_FEE = '0x00000000000000000000000000000000000000B2';

test('an exact-opening schedule waits when the latest chain block is still before the public start', () => {
  const result = publicStageClock({ chainTimeMs:1_999_000, wallTimeMs:2_000_050,
    startTime:2_000, endTime:3_000, deadlineMs:5_000_000 });
  assert.equal(result.status,'wait');
  assert.equal(result.code,'CHAIN_NOT_AT_PUBLIC_OPEN');
  assert.equal(result.retryAt,2_000_300);
});

test('public stage clock follows SeaDrop boundary semantics and rejects an unconfigured window',()=>{
  assert.equal(publicStageClock({chainTimeMs:3_000_000,wallTimeMs:3_000_000,
    startTime:2_000,endTime:3_000,deadlineMs:4_000_000}).status,'ready');
  assert.equal(publicStageClock({chainTimeMs:3_001_000,wallTimeMs:3_001_000,
    startTime:2_000,endTime:3_000,deadlineMs:4_000_000}).code,'PUBLIC_STAGE_ENDED');
  assert.equal(publicStageClock({chainTimeMs:3_000_000,wallTimeMs:3_000_000,
    startTime:0,endTime:0,deadlineMs:4_000_000}).code,'PUBLIC_STAGE_UNVERIFIED');
});

test('the live allowed fee recipient replaces a stale cached recipient for restricted drops', () => {
  assert.equal(liveFeeRecipient({ cachedFeeRecipient:OLD_FEE,
    allowedFeeRecipients:[NEW_FEE],restrictFeeRecipients:true,walletAddress:WALLET }),NEW_FEE);
  assert.equal(liveFeeRecipient({ cachedFeeRecipient:OLD_FEE,
    allowedFeeRecipients:[],restrictFeeRecipients:true,walletAddress:WALLET }),null);
});

test('public preflight explains wallet allowance and total-supply failures before simulation', () => {
  const publicDrop={maxTotalMintableByWallet:5};
  const walletLimit=publicMintCapacity({quantity:2,publicDrop,
    mintStats:{minterNumMinted:'4',currentTotalSupply:'90',maxSupply:'100'}});
  assert.equal(walletLimit.code,'WALLET_MINT_LIMIT_REACHED');
  assert.match(walletLimit.reason,/already minted 4.*1 mint left.*requests 2/i);
  const soldOut=publicMintCapacity({quantity:2,publicDrop,
    mintStats:{minterNumMinted:'0',currentTotalSupply:'99',maxSupply:'100'}});
  assert.equal(soldOut.code,'MINT_SOLD_OUT');
  assert.match(soldOut.reason,/Only 1 NFT remains/i);
  assert.equal(publicMintCapacity({quantity:1,publicDrop:{maxTotalMintableByWallet:0},mintStats:null}).code,
    'WALLET_MINT_LIMIT_REACHED');
  assert.equal(publicMintCapacity({quantity:1,publicDrop:{maxTotalMintableByWallet:5},
    mintStats:{minterNumMinted:'0',currentTotalSupply:'0',maxSupply:'0'}}).code,'MINT_SOLD_OUT');
});

test('an opaque simulation records the checks that passed instead of only saying failed', () => {
  const reason=opaquePublicSimulationReason({capacity:{remaining:3n}});
  assert.match(reason,/public stage was open/i);
  assert.match(reason,/wallet had 3 mints left/i);
  assert.match(reason,/contract rejected.*without identifying another rule/i);
  assert.match(reason,/Nothing was sent/i);
});
