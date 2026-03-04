-- migrations/000003_add_round_name.up.sql
-- Adds a customizable display name to rounds so organizers can give them
-- descriptive titles like "Round 1", "Championship Round", or "Back Nine Blitz".
--
-- The DEFAULT 'Round' covers any existing rows already in the database.
-- New rows will have their name set explicitly by the application, typically
-- auto-populated to "Round N" based on the round_number at creation time.

ALTER TABLE rounds ADD COLUMN name VARCHAR NOT NULL DEFAULT 'Round';
