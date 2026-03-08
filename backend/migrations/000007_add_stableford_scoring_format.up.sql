-- 000007_add_stableford_scoring_format.up.sql
-- Adds standalone stableford as a scoring format.
-- Irish Rumble already has an irish_rumble_stableford variant, but plain stableford
-- is valid for individual stroke-play rounds scored by stableford points (not team format).
ALTER TYPE scoring_format ADD VALUE 'stableford';
