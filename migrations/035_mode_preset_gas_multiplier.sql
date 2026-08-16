-- "Degen" mode presets are supposed to bid gas up relative to the network's current price, not
-- only skip confirmation -- the Milestone 7a preset model had simulation/confirmation/verification
-- fields but nothing controlling fee aggression, so selecting a "fast" preset had no actual effect
-- on the gas price a mint would pay. 1.0 (no change from the network's own fee estimate) is the
-- floor: presets only ever bid gas *up*, never down, since underbidding risks a transaction that
-- never confirms.
ALTER TABLE mode_presets ADD COLUMN gas_price_multiplier NUMERIC NOT NULL DEFAULT 1.0
  CHECK (gas_price_multiplier >= 1.0 AND gas_price_multiplier <= 10.0);

UPDATE mode_presets SET gas_price_multiplier = 1.5 WHERE preset_key = 'ultra_fast';
UPDATE mode_presets SET gas_price_multiplier = 1.2 WHERE preset_key = 'fast';
UPDATE mode_presets SET gas_price_multiplier = 1.05 WHERE preset_key = 'semi_safe';
UPDATE mode_presets SET gas_price_multiplier = 1.0 WHERE preset_key = 'safe';
