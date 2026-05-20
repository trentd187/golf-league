ALTER TABLE events
    DROP COLUMN is_public;

-- PostgreSQL does not support removing enum values; the 'pending' value
-- remains in the type but is unused after this migration is rolled back.
