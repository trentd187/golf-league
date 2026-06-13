-- 000023_add_guest_users.down.sql
-- Reverses 000023_add_guest_users.up.sql.

ALTER TABLE users DROP COLUMN is_guest;
