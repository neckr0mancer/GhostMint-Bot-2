const { randomUUID } = require('node:crypto');
const { planWaves } = require('./planner');

// Orchestrates a staged squad through firing and settlement.
//
// Firing: members go out wave-by-wave; within a wave every send starts simultaneously
// (Promise.allSettled) -- waves shape load, they do not pace the mint. Each send is an ordinary
// executePrepared call (full idempotency, intent persistence, governance ceilings, nonce safety)
// with triggerSource 'launch', which transactionEngine treats like scheduled/sniper fires on its
// fast path. A member's send failure marks that member failed and never aborts the wave.
//
// Settlement: submit() returns at broadcast-pending, not finality (the nonce queue releases there),
// so the launcher reconciles every sent member's intent to a final state in the background and then
// writes the report card. Reconciliation reuses transactionEngine.reconcileIntent -- the same
// mechanism the scheduler settles with -- so "what happened to my mint" has one source of truth.
function createLauncher({ repository, stager, mintExecution, mintService, transactionEngine, intentRepository,
  findWallet, notify = () => {}, log = () => {}, now = () => Date.now(),
  // How long settlement keeps polling intents before giving up and marking them unknown-fate in the
  // report. Generous: finality on polygon alone can take minutes.
  settleTimeoutMs = 15 * 60_000, settleIntervalMs = 5_000 }) {

  let timer = null;

  async function createAndStage({ userId, name, chain, contractAddress, quantity = 1, manualPriceWei = null,
    wallets, maxWaveSize = 25, triggerType = 'manual', fireAt = null, gasPriceWei = null }) {
    const { plan, results } = await stager.stageSquad({ userId, chain, contractAddress, quantity, manualPriceWei,
      members: wallets.map(label => ({ label })) });
    // Skipped wallets keep their record for the report but sort to the very back so they never sit
    // in front of live wallets in any wave listing.
    const waves = planWaves({
      wallets: results.map(entry => ({ label: entry.label,
        priority: entry.status === 'staged' ? (entry.priority ?? 100) : 10_000 + (entry.priority ?? 100) })),
      maxWaveSize,
    });
    const id = randomUUID();
    await repository.createSquad({
      id, userId, name: name || `${chain}:${contractAddress.slice(0, 10)}..`, chain, contractAddress, quantity,
      methodSignature: plan.methodSignature, seaDropAddress: plan.seaDropAddress, feeRecipient: plan.feeRecipient,
      priceWei: plan.priceWei, gasPriceWei, triggerType, fireAt, status: 'staged', waveSize: maxWaveSize,
      members: waves.map(({ label, wave, priority }) => ({ walletLabel: label, wave, priority })),
    });
    return repository.getSquad(userId, id);
  }

  async function fire(squad) {
    if (!squad.members?.length) throw new Error('squad has no members');
    const sendable = squad.members.filter(member => member.status !== 'skipped' && member.status !== 'failed');
    if (!sendable.length) throw new Error('every member was skipped or already failed -- nothing to fire');
    const size = Math.max(1, squad.waveSize || 25);
    await repository.updateSquad(squad.id, { status: 'firing', firedAt: new Date(now()) });
    notify({ type: 'launch.starting', squad });

    const outcomes = [];
    for (let offset = 0; offset < sendable.length; offset += size) {
      const wave = sendable.slice(offset, offset + size);
      const settled = await Promise.allSettled(wave.map(member => sendMember(squad, member)));
      settled.forEach((result, index) => {
        const member = wave[index];
        const error = result.status === 'rejected' ? result.reason : null;
        outcomes.push({ member, ok: result.status === 'fulfilled', error: error ? String(error.message || error).slice(0, 300) : null });
      });
    }
    void settleInBackground(squad, outcomes);
    return outcomes;
  }

  async function sendMember(squad, member) {
    try {
      const wallet = findWallet(squad.userId, member.walletLabel);
      if (!wallet) throw new Error('wallet not found');
      const prepared = await mintService.prepare({
        contractAddress: squad.contractAddress,
        methodSignature: squad.methodSignature,
        ...(squad.seaDropAddress ? { seaDropAddress: squad.seaDropAddress } : {}),
        arguments: squad.seaDropAddress ? [squad.feeRecipient, '$wallet', squad.quantity] : [squad.quantity],
        walletAddress: wallet.address,
        valueWei: squad.priceWei === null ? 0n : BigInt(squad.priceWei) * BigInt(squad.quantity),
        chain: squad.chain,
      });
      const intent = await mintExecution.executePrepared({
        userId: squad.userId, wallet, prepared, triggerSource: 'launch',
        gasPriceWei: squad.gasPriceWei === null || squad.gasPriceWei === undefined ? undefined : BigInt(squad.gasPriceWei),
        idempotencyKey: `launch:${squad.id}:${member.walletLabel}`,
        onIntentPersisted: persisted => repository.updateMemberStatus(squad.id, member.walletLabel,
          { intentId: persisted.intentId, txHash: persisted.txHash || null, status: 'sent', sentAt: new Date(now()) }),
      });
      await repository.updateMemberStatus(squad.id, member.walletLabel,
        { status: 'sent', txHash: intent.txHash || null, intentId: intent.intentId, sentAt: new Date(now()) });
      return intent;
    } catch (error) {
      await repository.updateMemberStatus(squad.id, member.walletLabel,
        { status: 'failed', error: String(error.message || error).slice(0, 300) }).catch(() => {});
      throw error;
    }
  }

  async function settleInBackground(squad, outcomes) {
    const intents = outcomes.filter(entry => entry.ok && entry.member.intentId)
      .map(entry => ({ label: entry.member.walletLabel, intentId: entry.member.intentId }));
    const deadline = now() + settleTimeoutMs;
    const pending = new Map(intents.map(entry => [entry.label, entry.intentId]));
    while (pending.size && now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, settleIntervalMs));
      for (const [label, intentId] of [...pending]) {
        try {
          const current = await intentRepository.get(intentId);
          if (!current) { pending.delete(label); continue; }
          const intent = await transactionEngine.reconcileIntent(current);
          if (intent.state === 'confirmed' || intent.state === 'reverted' || intent.state === 'replaced') {
            pending.delete(label);
            await repository.updateMemberStatus(squad.id, label, {
              status: intent.state === 'confirmed' ? 'confirmed' : 'reverted',
              confirmedAt: new Date(now()),
              error: intent.state === 'confirmed' ? null : `transaction ${intent.state}`,
            }).catch(() => {});
          }
        } catch (error) {
          log(`Launch settlement lookup failed for ${label}: ${error.message}`);
        }
      }
    }
    for (const [label] of pending) {
      await repository.updateMemberStatus(squad.id, label, { status: 'failed', error: 'settlement window elapsed without a final state' }).catch(() => {});
    }
    const fresh = await repository.getSquad(squad.userId, squad.id);
    const counts = {};
    for (const member of fresh.members) counts[member.status] = (counts[member.status] || 0) + 1;
    const report = { finishedAt: new Date(now()).toISOString(), counts, total: fresh.members.length };
    await repository.updateSquad(squad.id, { status: 'done', report });
    notify({ type: 'launch.done', squad: fresh, report });
  }

  // Timer-triggered squads: a light poll (the scheduler's precise-timer machinery stays where it
  // belongs; launches gain sub-second precision later via block-height triggers anyway).
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      repository.listDueTimerSquads(now()).then(due => {
        for (const squad of due) {
          fire(squad).catch(error => log(`Launch squad ${squad.name} failed to fire: ${error.message}`));
        }
      }).catch(error => log(`Launch timer scan failed: ${error.message}`));
    }, 1000);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { createAndStage, fire, start, stop };
}

module.exports = { createLauncher };
