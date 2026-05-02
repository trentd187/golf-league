-- Restore the manager enum value.
-- Note: the original manager user assignments are lost — this only restores the type,
-- not which users had the manager role before the up migration ran.
ALTER TYPE user_role RENAME TO user_role_old;
CREATE TYPE user_role AS ENUM ('admin', 'manager', 'user');
ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::text::user_role;
DROP TYPE user_role_old;
