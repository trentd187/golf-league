-- Migration 000015: add tee shot stats to hole_stats and user-level scorecard settings.
-- tee_shot_club is constrained to a fixed club set; tee_shot_distance is yards (int).
-- user_scorecard_settings stores one row per user with a boolean per toggleable stat.
-- Existing stats (fir, gir, putts, approach_yds) default to TRUE to preserve current
-- behaviour for users who have not yet set preferences.

ALTER TABLE hole_stats
  ADD COLUMN tee_shot_club     TEXT CHECK (tee_shot_club IN ('DR','3W','5W','7W','DI','3H')),
  ADD COLUMN tee_shot_distance INT;

CREATE TABLE user_scorecard_settings (
  user_id                     UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  fir_enabled                 BOOL        NOT NULL DEFAULT TRUE,
  gir_enabled                 BOOL        NOT NULL DEFAULT TRUE,
  putts_enabled               BOOL        NOT NULL DEFAULT TRUE,
  first_putt_distance_enabled BOOL        NOT NULL DEFAULT TRUE,
  putt_distance_made_enabled  BOOL        NOT NULL DEFAULT TRUE,
  approach_yds_enabled        BOOL        NOT NULL DEFAULT TRUE,
  tee_shot_club_enabled       BOOL        NOT NULL DEFAULT FALSE,
  tee_shot_distance_enabled   BOOL        NOT NULL DEFAULT FALSE,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
