-- 000023_add_guest_users.up.sql
-- Adds support for "guest" players: lightweight, account-less participants whose
-- only purpose is to have their scores tracked in a round (team games like Best Ball
-- and Las Vegas, or any round). A guest is a normal users row with is_guest = true,
-- a NULL auth_id (no Supabase identity), and a synthetic unique email. Guests are
-- created per-round and join a round directly via round_players (event_player_id NULL),
-- so no schema change is needed beyond this flag.

ALTER TABLE users ADD COLUMN is_guest BOOLEAN NOT NULL DEFAULT false;
