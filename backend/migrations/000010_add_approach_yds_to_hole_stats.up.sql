-- Add optional approach shot distance (yards) to per-hole stats.
-- Nullable because most users will not track this field.
ALTER TABLE hole_stats ADD COLUMN approach_yds INT NULL;
