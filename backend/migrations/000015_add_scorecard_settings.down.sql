-- Reverse migration 000015.
DROP TABLE user_scorecard_settings;

ALTER TABLE hole_stats
  DROP COLUMN tee_shot_club,
  DROP COLUMN tee_shot_distance;
