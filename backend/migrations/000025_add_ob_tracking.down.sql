ALTER TABLE user_scorecard_settings
  DROP COLUMN ob_enabled;

ALTER TABLE hole_stats
  DROP COLUMN gir_ob,
  DROP COLUMN fir_ob;
