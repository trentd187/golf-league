-- Add optional name to groups — used for team names or custom group labels.
-- Nullable so existing groups are unaffected; an empty/absent name falls back
-- to the "Group N" display in clients.
ALTER TABLE groups ADD COLUMN name TEXT;
