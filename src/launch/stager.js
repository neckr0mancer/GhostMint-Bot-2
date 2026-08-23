// Pre-flight staging for a launch squad: everything that can be verified or resolved BEFORE the
// fire moment happens here, so firing does no detection, no price reads, and no surprise-failure
// discovery. Staging answers three questions per squad:
//   1. What exactly will we send? (method + SeaDrop address/fee recipient + value per wallet)
//   2. Is the account allowed? (account-status enforcement, same choke as interactive commands)
//   3. Can every member wallet actually pay? (existence + balance >= mint value + gas buffer)
// Members that fail verification are marked 'skipped' with the reason -- they simply don't get
// fired -- rather than aborting the squad; a 40-wallet launch shouldn't die because one wallet is
// empty. The operator sees skips in the staging summary.
//
// Deliberately NOT done here: nonce reservation, fee locking, simulation. Those stay inside
// transactionEngine.submit at fire time (idempotency + freshness), except fees which fire-time
// code may override from the squad's staged gasPriceWei.
const SEADROP_MINT_SIGNATURE = 'mint(address,uint256)';

function createLaunchStager({ checkAccountStatus, findWallet, seaDropDiscoveryService,
  seaDropPublicDropResolver, providerService, log = () => {} }) {

  // Gas buffer heuristic for balance checks: a SeaDrop/ERC-721 mint costs ~150-300k gas; 400k at
  // current fast fees covers it with margin on every supported chain without being so large that
  // healthy wallets get skipped over dust-level shortfalls.
  const GAS_BUFFER_GAS_UNITS = 400_000n;

  async function stageSquad({ userId, chain, contractAddress, quantity, manualPriceWei = null, members }) {
    await checkAccountStatus(userId);
    const seaDrop = await seaDropDiscoveryService.resolve(chain, contractAddress);
    let methodSignature;
    let seaDropAddress = null;
    let feeRecipient = null;
    let priceWei;
    if (seaDrop.address) {
      const livePublicDrop = await seaDropPublicDropResolver.getPublicDrop(chain, seaDrop.address, contractAddress);
      if (!livePublicDrop) throw new Error('contract is SeaDrop but exposes no live PublicDrop -- cannot stage');
      methodSignature = SEADROP_MINT_SIGNATURE;
      seaDropAddress = seaDrop.address;
      feeRecipient = seaDrop.feeRecipient;
      priceWei = livePublicDrop.mintPriceWei;
    } else {
      methodSignature = 'mint(uint256)';
      if (manualPriceWei === null || manualPriceWei === undefined) {
        throw new Error('non-SeaDrop contract needs an explicit price (the chain does not expose one)');
      }
      priceWei = BigInt(manualPriceWei);
    }
    const valuePerWallet = priceWei * BigInt(quantity);

    const feeData = await providerService.perform(chain, 'launchStagingFee', provider => provider.getFeeData())
      .catch(() => null);
    // 1559 chains report maxFeePerGas; some legacy-only providers report gasPrice only -- use
    // whichever exists so the buffer never silently disappears (a null buffer would let a wallet
    // that cannot pay its own gas pass staging and fail later at send).
    const feePerGas = feeData?.maxFeePerGas ?? feeData?.gasPrice ?? null;
    const gasBufferWei = feePerGas ? feePerGas * GAS_BUFFER_GAS_UNITS : null;

    const results = [];
    for (const member of members) {
      try {
        const wallet = findWallet(userId, member.label);
        if (!wallet) throw new Error('wallet not found');
        if (String(wallet.chain || '') !== String(chain)) throw new Error(`wallet is on ${wallet.chain}, not ${chain}`);
        const balance = await providerService.perform(chain, `launchStagingBalance:${member.label}`,
          provider => provider.getBalance(wallet.address));
        const needed = valuePerWallet + (gasBufferWei ?? 0n);
        if (balance < needed) {
          throw new Error(`balance too low: has ${balance} wei, needs ~${needed}`);
        }
        results.push({ ...member, status: 'staged' });
      } catch (error) {
        log(`Launch staging skip [${member.label}]: ${error.message}`);
        results.push({ ...member, status: 'skipped', error: error.message });
      }
    }
    return { plan: { chain, contractAddress, quantity, methodSignature, seaDropAddress, feeRecipient, priceWei }, results };
  }

  return { stageSquad, SEADROP_MINT_SIGNATURE };
}

module.exports = { createLaunchStager, SEADROP_MINT_SIGNATURE };
