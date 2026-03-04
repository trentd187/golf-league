-- migrations/000004_remove_upcoming_event_status.up.sql
-- Removes the 'upcoming' value from the event_status enum.
-- Events now start as 'active' when created, so 'upcoming' is redundant.
--
-- PostgreSQL does not support DROP VALUE on an enum, so we follow the
-- standard workaround:
--   1. Create a replacement enum type (without 'upcoming')
--   2. Change the column to use the new type, converting any 'upcoming'
--      rows to 'active' via a CASE expression
--   3. Drop the old enum
--   4. Rename the new enum to the original name
--
-- The column DEFAULT is also updated to 'active' to match the new behaviour.

-- Step 1: new enum without 'upcoming'
CREATE TYPE event_status_new AS ENUM ('active', 'completed', 'cancelled');

-- Step 2: migrate the column.
-- Any existing rows where status = 'upcoming' become 'active'.
-- All other values cast directly to the new type unchanged.
ALTER TABLE events
    ALTER COLUMN status TYPE event_status_new
    USING (
        CASE status::text
            WHEN 'upcoming' THEN 'active'::event_status_new
            ELSE status::text::event_status_new
        END
    );

-- Update the column DEFAULT to 'active' now that 'upcoming' no longer exists.
ALTER TABLE events
    ALTER COLUMN status SET DEFAULT 'active'::event_status_new;

-- Step 3: remove the old type (must happen after the column is migrated)
DROP TYPE event_status;

-- Step 4: rename the replacement type to the canonical name so application
-- code referencing the type name 'event_status' continues to work.
ALTER TYPE event_status_new RENAME TO event_status;
