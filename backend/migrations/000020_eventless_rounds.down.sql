-- 000020_eventless_rounds.down.sql
-- Reverses the eventless rounds migration.
-- WARNING: restoring NOT NULL on event_player_id will fail if any eventless
-- round_players exist. Remove them first before rolling back.

ALTER TABLE round_players ALTER COLUMN event_player_id SET NOT NULL;
ALTER TABLE round_players DROP COLUMN user_id;
ALTER TABLE rounds DROP COLUMN created_by;
ALTER TABLE rounds ALTER COLUMN event_id SET NOT NULL;
