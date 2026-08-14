ALTER TABLE social_watch_rules DROP CONSTRAINT social_watch_rules_type_check;
ALTER TABLE social_watch_rules ADD CONSTRAINT social_watch_rules_type_check
  CHECK (type IN ('twitter_account','twitter_keyword','discord_channel','discord_keyword',
    'farcaster_account','farcaster_keyword'));

ALTER TABLE social_trigger_events DROP CONSTRAINT social_trigger_events_platform_check;
ALTER TABLE social_trigger_events ADD CONSTRAINT social_trigger_events_platform_check
  CHECK (platform IN ('twitter','discord','farcaster'));
