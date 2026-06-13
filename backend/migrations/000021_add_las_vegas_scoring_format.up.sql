-- 000021_add_las_vegas_scoring_format.up.sql
-- Adds the Las Vegas 2v2 team betting game as a scoring format, plus two per-round
-- toggles that configure it. Players play individual balls (scores stay per-player);
-- the Vegas math is derived client-side, so no team_scores changes are needed.
--
-- NOTE: ADD VALUE cannot be used in the same transaction that references the new
-- value, so this migration only adds the value (mirrors 000007). The columns default
-- safely for every existing non-Vegas round.
ALTER TYPE scoring_format ADD VALUE 'las_vegas';

-- vegas_birdie_flip: when a team birdies, the opponents' two-digit number flips
-- high-digit-first. vegas_scoring_basis: "gross" or "net" for the combination.
ALTER TABLE rounds ADD COLUMN vegas_birdie_flip BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE rounds ADD COLUMN vegas_scoring_basis TEXT NOT NULL DEFAULT 'gross';
