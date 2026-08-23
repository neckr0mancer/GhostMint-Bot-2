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
  findWallet, triggers = null, notify = () => {}, log = () => {}, now = () => Date.now(),
  // How long settlement keeps polling intents before giving up and marking them unknown-fate in the
  // report. Generous: finality on polygon alone can take minutes.
  settleTimeoutMs = 15 * 60_000, settleIntervalMs = 5_000 }) {

  let timer = null;

  async function createAndStage({ userId, name, chain, contractAddress, quantity = 1, manualPriceWei = null,
    wallets, maxWaveSize = 25, triggerType = 'manual', fireAt = null, gasPriceWei = null }) {
    const { plan, results } = await stager.stageSquad({ userId, chain, contractAddress, quantity, manualPriceWei,
      members: wallets.map(label => ({ label })) });
    // Skipped wallets keep their record for the report but carry their staging verdict through to
    // persistence -- fire() filters on it, so a wallet staging rejected as unfundable must arrive
    // here already marked 'skipped', not as a fireable 'pending'.
    const verdict = new Map(results.map(entry => [entry.label, entry]));
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
      members: waves.map(({ label, wave, priority }) => {
        const result = verdict.get(label) || {};
        return { walletLabel: label, wave, priority,
          status: result.status === 'skipped' ? 'skipped' : 'staged',
          error: result.error ?? null };
      }),
    });
    return repository.getSquad(userId, id);
  }

  async function fire(squadOrId) {
    const id = typeof squadOrId === 'string' ? squadOrId : squadOrId?.id;
    // Atomic claim first: exactly one caller (timer tick, Telegram, Discord) ever moves a squad
    // into firing. Losing the race returns null -- the winner is already launching.
    const claimed = await repository.claimForFire(id);
    if (!claimed) return null;
    if (triggers) triggers.dispose(id);
    // Re-read AFTER claiming: the caller's snapshot may be stale by seconds; members' statuses and
    // the squad's own fields must come from the same post-claim state the settlement will see.
    const squad = await repository.getSquadById(id);
    if (!squad.members?.length) throw new Error('squad has no members');
    const sendable = squad.members.filter(member => member.status !== 'skipped' && member.status !== 'failed');
    if (!sendable.length) {
      await repository.updateSquad(squad.id, { status: 'failed', report: { error: 'every member was skipped or already failed' } });
      throw new Error('every member was skipped or already failed -- nothing to fire');
    }
    const size = Math.max(1, squad.waveSize || 25);
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

  // Attach (or clear) an event trigger on a staged squad. 'manual'/'timer' clears any live
  // subscription; 'block'/'pending' persist the target and arm immediately -- an arm failure here
  // is fatal to the request (the squad stays exactly as it was) because a trigger that silently
  // never fires is worse than one that refuses to arm.
  async function setTarget(squad, kind, targetBlock = null) {
    if (squad.status !== 'staged') throw new Error(`squad is ${squad.status} -- triggers attach only while staged`);
    // 'timer' is deliberately rejected here: a timer needs fire_at, which only the create path
    // sets. Persisting triggerType='timer' without one strands the squad forever -- the timer
    // scan matches fire_at <= now, and NULL never satisfies it.
    if (kind === 'block') {
      if (!Number.isFinite(Number(targetBlock)) || Number(targetBlock) <= 0) throw new Error('block trigger needs a positive block number');
    } else if (!['pending', 'manual'].includes(kind)) {
      throw new Error(`unknown trigger: ${kind} (use manual, pending, or block with a target)`);
    }
    if (triggers && (squad.triggerType === 'block' || squad.triggerType === 'pending')) triggers.dispose(squad.id);
    if (kind === 'pending') {
      await repository.updateSquad(squad.id, { triggerType: kind, targetBlock: null });
      await triggers.arm({ squadId: squad.id, kind, chain: squad.chain,
        contractAddress: squad.contractAddress, targetBlock: Number(targetBlock) },
        () => { fire(squad.id).catch(error => log(`Launch trigger fire failed for "${squad.name}": ${error.message}`)); });
      log(`Launch squad "${squad.name}" armed on ${kind} trigger`);
    } else {
      await repository.updateSquad(squad.id, { triggerType: 'manual', targetBlock: null });
      if (triggers) triggers.dispose(squad.id);
    }
    return repository.getSquadById(squad.id);
  }

  // Abort from a command surface: disarm any live trigger first so a late event cannot fire an
  // aborted squad (fire's own atomic claim would refuse it anyway -- this just stops the noise).
  async function cancel(squad) {
    if (triggers) triggers.dispose(squad.id);
    if (!['staged', 'armed'].includes(squad.status)) throw new Error(`squad is already ${squad.status} -- too late to abort`);
    await repository.updateSquad(squad.id, { status: 'aborted' });
  }

  // Boot/scan-time re-arm: staged squads whose trigger kind is block/pending get their live
  // subscription back after a restart or if one dropped. An arm failure downgrades the squad to
  // manual and says so -- never a silent dead subscription.
  function armEligibleTriggers() {
    if (!triggers) return;
    repository.listTriggerCandidates().then(candidates => {
      for (const squad of candidates) {
        if (triggers.has(squad.id)) continue;
        triggers.arm({ squadId: squad.id, kind: squad.triggerType, chain: squad.chain,
          contractAddress: squad.contractAddress, targetBlock: squad.targetBlock },
          () => { fire(squad.id).catch(error => log(`Launch trigger fire failed for "${squad.name}": ${error.message}`)); })
          .catch(error => {
            log(`Launch squad "${squad.name}" trigger re-arm failed (${error.message}) -- reverting to manual`);
            repository.updateSquad(squad.id, { triggerType: 'manual', targetBlock: null }).catch(() => {});
            notify({ type: 'launch.triggerFailed', squad, error });
          });
      }
    }).catch(error => log(`Launch trigger scan failed: ${error.message}`));
  }

  // Timer-triggered squads: a light poll (the scheduler's precise-timer machinery stays where it
  // belongs; event-triggered squads arm through `triggers` instead of this loop).
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      repository.listDueTimerSquads(now()).then(due => {
        for (const squad of due) {
          fire(squad).catch(error => log(`Launch squad ${squad.name} failed to fire: ${error.message}`));
        }
      }).catch(error => log(`Launch timer scan failed: ${error.message}`));
      armEligibleTriggers();
    }, 1000);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; if (triggers) triggers.disarmAll(); }

  return { createAndStage, fire, start, stop, setTarget, cancel };
}

module.exports = { createLauncher };
