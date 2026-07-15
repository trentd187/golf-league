-- 000026_add_hot_path_indexes.up.sql
-- Index the foreign keys on the hottest query paths. Every one of these columns is filtered
-- on constantly and had NO usable index, so each query below was a sequential scan that grew
-- linearly with the whole table.
--
-- Two of them look indexed but are not. group_players and team_members have COMPOSITE primary
-- keys — (group_id, round_player_id) and (team_id, round_player_id). Postgres can only use a
-- composite B-tree for a prefix of its columns, so a lookup BY round_player_id alone (which is
-- how both are actually queried) cannot use the PK at all.
--
-- CONCURRENTLY is deliberately NOT used: golang-migrate runs each migration inside a
-- transaction, and CREATE INDEX CONCURRENTLY cannot run in one. These tables are small enough
-- that the brief write lock at deploy is a non-event.

-- Every load of the Rounds tab: WHERE user_id = ?  (round_service.go GetMyRounds)
-- Added by 000020 (eventless rounds) and never indexed.
CREATE INDEX IF NOT EXISTS idx_round_players_user_id ON round_players(user_id);

-- EVERY SCORE WRITE. canModifyScores does First(&targetGP, "round_player_id = ?") on the
-- permission check for every single score and hole-stat save — a seq scan on the busiest
-- write path in the app, on the one table that grows with every hole every player plays.
CREATE INDEX IF NOT EXISTS idx_group_players_round_player_id ON group_players(round_player_id);

-- Team membership lookups + the delete-by-player in team assignment (round_service.go).
CREATE INDEX IF NOT EXISTS idx_team_members_round_player_id ON team_members(round_player_id);

-- Hit twice per player per scorecard load (scores + hole_stats), and once more per player in
-- the stats screen's batched scorecard fetch.
CREATE INDEX IF NOT EXISTS idx_hole_stats_round_player_id ON hole_stats(round_player_id);

-- Eventless rounds resolve their organizer via rounds.created_by.
CREATE INDEX IF NOT EXISTS idx_rounds_created_by ON rounds(created_by);
