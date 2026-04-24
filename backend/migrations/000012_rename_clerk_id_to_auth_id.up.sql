-- Rename clerk_id to auth_id to decouple the column from the Clerk auth provider.
-- Supabase Auth user IDs are UUIDs stored as text — the column type is unchanged.
ALTER TABLE users RENAME COLUMN clerk_id TO auth_id;
