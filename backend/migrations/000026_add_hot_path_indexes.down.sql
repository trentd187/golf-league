-- 000026_add_hot_path_indexes.down.sql
-- Exactly reverses 000026_add_hot_path_indexes.up.sql.

DROP INDEX IF EXISTS idx_rounds_created_by;
DROP INDEX IF EXISTS idx_hole_stats_round_player_id;
DROP INDEX IF EXISTS idx_team_members_round_player_id;
DROP INDEX IF EXISTS idx_group_players_round_player_id;
DROP INDEX IF EXISTS idx_round_players_user_id;
