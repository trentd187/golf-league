-- Migrate the global role system from three tiers (admin, manager, user) to two (admin, user).
-- The manager role is no longer needed: any authenticated user can now create and manage
-- their own events. Event-level organizer/player roles are unchanged.
--
-- PostgreSQL does not support DROP VALUE on an existing enum, so we use the
-- rename-and-recreate pattern to remove 'manager' from the user_role type.

-- Step 1: promote existing manager users to user before removing the enum value.
UPDATE users SET role = 'user' WHERE role = 'manager';

-- Step 2: swap the enum type.
-- The column has a DEFAULT 'user'::user_role. PostgreSQL stores the default with an
-- implicit cast to the current type, so we must drop it before changing the type and
-- re-add it afterward — otherwise ALTER COLUMN TYPE fails trying to convert the default.
ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
ALTER TYPE user_role RENAME TO user_role_old;
CREATE TYPE user_role AS ENUM ('admin', 'user');
ALTER TABLE users ALTER COLUMN role TYPE user_role USING role::text::user_role;
DROP TYPE user_role_old;
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';
