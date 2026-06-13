-- 000022_add_best_ball_scoring_format.up.sql
-- Adds Best Ball as a scoring format. Best Ball is a team game where every player
-- plays their own ball the whole hole, but only the single lowest score on a team
-- counts for that hole. Teams partition a playing group (free-form sizes: 2v2, 4v4,
-- 2v2v2v2, ...). Like Las Vegas, scores stay per-player and the team math is derived
-- client-side, so no team_scores changes are needed.
--
-- NOTE: ADD VALUE cannot be used in the same transaction that references the new
-- value (mirrors 000007/000021), so this migration only adds the value plus the
-- per-round gross/net toggle. The column defaults safely for existing rounds.
ALTER TYPE scoring_format ADD VALUE 'best_ball';

-- best_ball_scoring_basis: "gross" or "net" — selects which score the best-ball
-- comparison uses. Best Ball has no birdie-flip concept, so this is its only toggle.
ALTER TABLE rounds ADD COLUMN best_ball_scoring_basis TEXT NOT NULL DEFAULT 'gross';
