-- 000006_update_scoring_formats.up.sql
-- Replaces the 7-value scoring_format enum with 5 values that match the app's
-- actual supported formats. Any existing rows using removed formats are mapped to
-- the closest equivalent so the migration is non-destructive.
--
-- Old → New mapping:
--   net_stroke  → stroke          (net scoring is always derived from handicap, not a separate format)
--   stableford  → irish_rumble_stableford  (stableford scoring lives inside Irish Rumble)
--   skins       → stroke          (no replacement; closest is stroke)
--   best_ball   → scramble        (team scramble is the closest equivalent)

CREATE TYPE scoring_format_new AS ENUM (
    'stroke',
    'irish_rumble',
    'irish_rumble_stableford',
    'scramble',
    'match_play'
);

ALTER TABLE rounds
    ALTER COLUMN scoring_format TYPE scoring_format_new
    USING (
        CASE scoring_format::text
            WHEN 'net_stroke'  THEN 'stroke'::scoring_format_new
            WHEN 'stableford'  THEN 'irish_rumble_stableford'::scoring_format_new
            WHEN 'skins'       THEN 'stroke'::scoring_format_new
            WHEN 'best_ball'   THEN 'scramble'::scoring_format_new
            ELSE scoring_format::text::scoring_format_new
        END
    );

DROP TYPE scoring_format;
ALTER TYPE scoring_format_new RENAME TO scoring_format;
