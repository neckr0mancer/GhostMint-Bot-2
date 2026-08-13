ALTER TABLE target_trigger_policies
  ADD COLUMN mode_preset_key TEXT REFERENCES mode_presets(preset_key) ON DELETE SET NULL;
