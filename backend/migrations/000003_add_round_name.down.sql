-- migrations/000003_add_round_name.down.sql
-- Reverses 000003_add_round_name.up.sql — removes the name column from rounds.

ALTER TABLE rounds DROP COLUMN name;
