-- migrations/000001_initial_schema.down.sql
-- This is the "down" migration — it completely undoes the "up" migration.
-- Running this returns the database to the state it was in BEFORE migration 000001 was applied.
-- It is used during development to reset the schema, or in production to roll back a bad migration.
--
-- IMPORTANT: Tables must be dropped in reverse dependency order.
-- If table B has a foreign key pointing to table A, then B must be dropped before A.
-- Dropping A first would fail because B still references it.
-- This mirrors the creation order in the up migration, but reversed.

-- Drop tables in reverse dependency order
-- (Tables that reference others are dropped first)
DROP TABLE IF EXISTS team_scores;    -- References teams and users
DROP TABLE IF EXISTS team_members;   -- References teams and round_players
DROP TABLE IF EXISTS teams;          -- References rounds
DROP TABLE IF EXISTS group_players;  -- References groups and round_players
DROP TABLE IF EXISTS groups;         -- References rounds
DROP TABLE IF EXISTS scores;         -- References round_players and users
DROP TABLE IF EXISTS round_players;  -- References rounds and event_players
DROP TABLE IF EXISTS rounds;         -- References events, courses, and tees
DROP TABLE IF EXISTS event_players;  -- References events and users
DROP TABLE IF EXISTS event_points_rules; -- References events
DROP TABLE IF EXISTS events;         -- References users
DROP TABLE IF EXISTS holes;          -- References tees
DROP TABLE IF EXISTS tees;           -- References courses
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS users;          -- No outgoing foreign keys — safe to drop last

-- Drop enums
-- Custom PostgreSQL types must be dropped after all tables that use them are gone.
-- Dropped in reverse creation order (least dependent first).
DROP TYPE IF EXISTS round_player_status;
DROP TYPE IF EXISTS event_player_status;
DROP TYPE IF EXISTS event_player_role;
DROP TYPE IF EXISTS tee_gender;
DROP TYPE IF EXISTS scoring_format;
DROP TYPE IF EXISTS round_status;
DROP TYPE IF EXISTS event_status;
DROP TYPE IF EXISTS event_type;
DROP TYPE IF EXISTS user_role;
