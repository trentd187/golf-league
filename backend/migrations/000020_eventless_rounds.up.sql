-- 000020_eventless_rounds.up.sql
-- Allows rounds to exist without an event (casual/solo play).
-- Adds created_by to rounds for organizer checks on eventless rounds.
-- Adds user_id directly to round_players so eventless players can be assigned
-- without going through the event_players join table.

-- Make event_id optional on rounds
ALTER TABLE rounds ALTER COLUMN event_id DROP NOT NULL;

-- Track creator for organizer checks when event_id is null
ALTER TABLE rounds ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Add direct user_id to round_players (required for eventless players)
ALTER TABLE round_players ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Backfill user_id for all existing round_players from their event_player record
UPDATE round_players rp
SET user_id = ep.user_id
FROM event_players ep
WHERE rp.event_player_id = ep.id;

-- Enforce NOT NULL going forward (backfill ensures no existing nulls remain)
ALTER TABLE round_players ALTER COLUMN user_id SET NOT NULL;

-- Allow event_player_id to be NULL for eventless round_players
ALTER TABLE round_players ALTER COLUMN event_player_id DROP NOT NULL;
