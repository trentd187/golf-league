-- 000006_update_scoring_formats.down.sql
-- Restores the original 7-value scoring_format enum.
-- irish_rumble and irish_rumble_stableford both map back to stableford as the
-- closest available value in the old enum.

CREATE TYPE scoring_format_old AS ENUM (
    'stroke',
    'net_stroke',
    'stableford',
    'skins',
    'match_play',
    'scramble',
    'best_ball'
);

ALTER TABLE rounds
    ALTER COLUMN scoring_format TYPE scoring_format_old
    USING (
        CASE scoring_format::text
            WHEN 'irish_rumble'             THEN 'stableford'::scoring_format_old
            WHEN 'irish_rumble_stableford'  THEN 'stableford'::scoring_format_old
            ELSE scoring_format::text::scoring_format_old
        END
    );

DROP TYPE scoring_format;
ALTER TYPE scoring_format_old RENAME TO scoring_format;
