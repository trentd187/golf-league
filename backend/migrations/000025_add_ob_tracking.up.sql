-- Migration 000025: add out-of-bounds (OB) tracking.
-- OB is an additive flag on the tee shot (fir_ob) and the approach (gir_ob): a shot
-- can go both a direction AND OB on the same hole, so these are independent of the
-- existing fir/gir accuracy fields. Nullable like every other hole_stats field.
-- ob_enabled toggles the OB pill in the advanced scorecard; defaults TRUE to match
-- the always-on framing of FIR/GIR.

ALTER TABLE hole_stats
  ADD COLUMN fir_ob BOOLEAN,
  ADD COLUMN gir_ob BOOLEAN;

ALTER TABLE user_scorecard_settings
  ADD COLUMN ob_enabled BOOL NOT NULL DEFAULT TRUE;
