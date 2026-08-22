// Wave planning for coordinated launches (src/launch). Pure logic, no I/O -- the launcher hands it
// wallet labels plus optional priorities and gets back ordered waves. Priorities are "lower fires
// earlier": guaranteed-spot wallets can be given 0 so they lead wave 0 even if they were selected
// last; everything else defaults to 100 and keeps its selection order. Waves exist to shape load
// (provider rate limits, DB contention), not to pace the mint itself -- within a wave every send
// starts simultaneously; waves launch back-to-back with no artificial gap beyond natural latency.
function planWaves({ wallets, maxWaveSize = 25 }) {
  const list = (wallets || []).map((entry, index) => {
    const label = typeof entry === 'string' ? entry : entry.label;
    const priority = typeof entry === 'object' && entry.priority !== undefined ? entry.priority : 100;
    return { label: String(label), priority: Number(priority), index };
  }).filter(entry => entry.label);
  // Stable sort by (priority, original order) -- Array.prototype.sort is stable in Node, but the
  // explicit index tiebreak keeps that guarantee obvious rather than incidental.
  list.sort((a, b) => a.priority - b.priority || a.index - b.index);
  const size = Math.max(1, Math.floor(maxWaveSize));
  const waves = [];
  for (let i = 0; i < list.length; i += size) {
    waves.push(list.slice(i, i + size).map(entry => ({ label: entry.label, wave: waves.length, priority: entry.priority })));
  }
  return waves.flat().map(({ label, wave, priority }) => ({ label, wave, priority }));
}

module.exports = { planWaves };
