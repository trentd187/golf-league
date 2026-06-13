-- 000021_add_las_vegas_scoring_format.down.sql
-- Reverses 000021. Drops the two Vegas toggle columns, then removes the 'las_vegas'
-- enum value. PostgreSQL cannot DROP a value from an enum directly — the type must
-- be recreated. Any rounds using 'las_vegas' are remapped to 'stroke' before removal.
ALTER TABLE rounds DROP COLUMN IF EXISTS vegas_scoring_basis;
ALTER TABLE rounds DROP COLUMN IF EXISTS vegas_birdie_flip;

CREATE TYPE scoring_format_new AS ENUM (
    'stroke',
    'stableford',
    'irish_rumble',
    'irish_rumble_stableford',
    'scramble',
    'match_play'
);

ALTER TABLE rounds
    ALTER COLUMN scoring_format TYPE scoring_format_new
    USING (
        CASE scoring_format::text
            WHEN 'las_vegas' THEN 'stroke'::scoring_format_new
            ELSE scoring_format::text::scoring_format_new
        END
    );

DROP TYPE scoring_format;
ALTER TYPE scoring_format_new RENAME TO scoring_format;
