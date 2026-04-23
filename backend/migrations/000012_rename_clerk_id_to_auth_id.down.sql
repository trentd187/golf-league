-- Reverse the clerk_id → auth_id rename.
ALTER TABLE users RENAME COLUMN auth_id TO clerk_id;
