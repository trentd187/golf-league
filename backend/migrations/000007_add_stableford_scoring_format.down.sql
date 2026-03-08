-- 000007_add_stableford_scoring_format.down.sql
-- PostgreSQL cannot DROP a value from an enum directly — the type must be recreated.
-- Any rounds using 'stableford' are remapped to 'irish_rumble_stableford' before removal.
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
            WHEN 'stableford' THEN 'irish_rumble_stableford'::scoring_format_new
            ELSE scoring_format::text::scoring_format_new
        END
    );

DROP TYPE scoring_format;
ALTER TYPE scoring_format_new RENAME TO scoring_format;
