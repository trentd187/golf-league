-- migrations/000004_remove_upcoming_event_status.down.sql
-- Reverses 000004_remove_upcoming_event_status.up.sql.
-- Restores 'upcoming' as a valid event_status value and reverts the
-- column DEFAULT back to 'upcoming'.
--
-- Note: rows that were converted from 'upcoming' → 'active' during the up
-- migration cannot be automatically recovered — those values are gone.
-- All currently 'active' rows remain 'active' after this rollback.

-- Step 1: create the full original enum with 'upcoming' restored
CREATE TYPE event_status_new AS ENUM ('upcoming', 'active', 'completed', 'cancelled');

-- Step 2: cast the column to the restored type.
-- All existing values (active, completed, cancelled) cast directly — no data loss.
ALTER TABLE events
    ALTER COLUMN status TYPE event_status_new
    USING status::text::event_status_new;

-- Restore the original default of 'upcoming'
ALTER TABLE events
    ALTER COLUMN status SET DEFAULT 'upcoming'::event_status_new;

-- Step 3: drop the current (post-migration) type
DROP TYPE event_status;

-- Step 4: rename back to the canonical name
ALTER TYPE event_status_new RENAME TO event_status;
