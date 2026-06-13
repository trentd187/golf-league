-- 000022_add_best_ball_scoring_format.down.sql
-- Reverses 000022. Drops the best_ball toggle column, then removes the 'best_ball'
-- enum value. PostgreSQL cannot DROP a value from an enum directly — the type must
-- be recreated. Any rounds using 'best_ball' are remapped to 'stroke' before removal.
ALTER TABLE rounds DROP COLUMN IF EXISTS best_ball_scoring_basis;

CREATE TYPE scoring_format_new AS ENUM (
    'stroke',
    'stableford',
    'irish_rumble',
    'irish_rumble_stableford',
    'scramble',
    'match_play',
    'las_vegas'
);

ALTER TABLE rounds
    ALTER COLUMN scoring_format TYPE scoring_format_new
    USING (
        CASE scoring_format::text
            WHEN 'best_ball' THEN 'stroke'::scoring_format_new
            ELSE scoring_format::text::scoring_format_new
        END
    );

DROP TYPE scoring_format;
ALTER TYPE scoring_format_new RENAME TO scoring_format;
