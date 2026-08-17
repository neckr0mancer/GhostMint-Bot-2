-- Canonical display names now match what every other surface (Discord /mode, Telegram
-- Settings > Transaction mode, dashboard Settings) has called these for a while (see
-- docs/WORKLIST.md Section C) -- only the admin Presets editor was still showing the old raw
-- names because it renders display_name directly with no client-side relabeling.
UPDATE mode_presets SET display_name='Degen' WHERE preset_key='ultra_fast';
UPDATE mode_presets SET display_name='Fast' WHERE preset_key='fast';
UPDATE mode_presets SET display_name='Cautious' WHERE preset_key='semi_safe';
UPDATE mode_presets SET display_name='Normie' WHERE preset_key='safe';

-- Exactly one default preset at a time -- applied to every user who has never explicitly
-- picked a mode (user_governance.selected_preset_key IS NULL), both for UI highlighting and
-- for actual policy enforcement (see getEffectiveGovernance's COALESCE join).
ALTER TABLE mode_presets ADD COLUMN is_default BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE mode_presets SET is_default=TRUE WHERE preset_key='safe';
CREATE UNIQUE INDEX mode_presets_single_default_idx ON mode_presets (is_default) WHERE is_default;

-- Degen and Fast trade safety for speed aggressively enough (1 confirmation + bypassed human
-- verification for Degen; blockchain-only simulation for Fast) that access is opt-in: a seat
-- group can allow it for everyone assigned to it, or an individual user can be granted it
-- directly regardless of group. Either path is sufficient (see isAdvancedModesAllowed).
ALTER TABLE seat_groups ADD COLUMN advanced_modes_allowed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE user_governance ADD COLUMN advanced_modes_allowed BOOLEAN;
