-- Migration 000016: add stat ordering and score position to user_scorecard_settings.
-- stat_order: comma-separated list of the 8 stat keys controlling display sequence.
-- score_position: 'first' (score above stats) or 'last' (score below stats, current default).

ALTER TABLE user_scorecard_settings
  ADD COLUMN stat_order     TEXT NOT NULL DEFAULT 'fir,gir,putts,first_putt_distance,putt_distance_made,approach_yds,tee_shot_club,tee_shot_distance',
  ADD COLUMN score_position TEXT NOT NULL DEFAULT 'last';

ALTER TABLE user_scorecard_settings
  ADD CONSTRAINT chk_score_position CHECK (score_position IN ('first', 'last'));
