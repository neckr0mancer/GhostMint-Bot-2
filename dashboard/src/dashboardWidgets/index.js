import ghostMint from './ghostMint.jsx';
import cleanVault from './cleanVault.jsx';
import neonArcade from './neonArcade.jsx';
import quietLedger from './quietLedger.jsx';

// ghost-mint-light is registered EXPLICITLY rather than falling through Dashboard.jsx's
// `|| THEME_WIDGETS['ghost-mint']` default, which is how it used to resolve. The fallback worked,
// but it made one of the two PRIMARY themes (brief §3.1) the only theme in the app with no entry
// of its own -- so a future edit to the default would silently change Light, and reading this map
// gave no hint that Light was even supported. Both primary themes now resolve by name.
//
// It shares ghostMint's module deliberately: Light and Dark are the same layout differing only by
// tokens, so a second copy would be a file to keep in sync for no design gain.
export const THEME_WIDGETS={
  'ghost-mint':ghostMint,
  'ghost-mint-light':ghostMint,
  'clean-vault':cleanVault,
  'neon-arcade':neonArcade,
  'quiet-ledger':quietLedger,
};
