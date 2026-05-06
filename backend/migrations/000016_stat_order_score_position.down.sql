-- Reverse migration 000016.
-- Constraint must be dropped before the column.

ALTER TABLE user_scorecard_settings
  DROP CONSTRAINT chk_score_position,
  DROP COLUMN stat_order,
  DROP COLUMN score_position;
