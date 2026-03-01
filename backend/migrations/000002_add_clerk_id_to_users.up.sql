-- migrations/000002_add_clerk_id_to_users.up.sql
-- Adds a clerk_id column to the users table so we can link a Clerk auth identity
-- (e.g. "user_2abc123") to our internal user record.
--
-- When a user signs in via Clerk for the first time, our API server looks up their
-- Clerk user ID in this column. If no row is found it creates one automatically.
-- This is called "lazy user sync" — users are created on their first API request
-- rather than needing a separate registration step or webhook.
--
-- Why nullable? Existing rows in the table (if any) won't have a clerk_id yet.
-- The NOT NULL constraint is enforced in application code: new rows always supply
-- a value, and the unique partial index prevents duplicate Clerk IDs.

ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_id VARCHAR;

-- A partial unique index covers only non-NULL values, so we can have rows without
-- a clerk_id without triggering uniqueness conflicts, while still guaranteeing
-- that no two rows share the same Clerk user ID.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_clerk_id ON users (clerk_id) WHERE clerk_id IS NOT NULL;
