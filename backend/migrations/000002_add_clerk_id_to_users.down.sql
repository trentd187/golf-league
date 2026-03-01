-- migrations/000002_add_clerk_id_to_users.down.sql
-- Reverses the 000002 up migration: removes the clerk_id column and its index.
-- This restores the users table to its original state from migration 000001.

DROP INDEX IF EXISTS idx_users_clerk_id;
ALTER TABLE users DROP COLUMN IF EXISTS clerk_id;
