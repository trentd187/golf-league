-- Add handicap_allowance to events.
-- Nullable decimal (0–100): NULL means no allowance configured (full handicap applies).
-- A value of 90 means each player's course_handicap is multiplied by 0.90 before
-- net score calculation. Enforced in the application layer, not a DB constraint.
ALTER TABLE events ADD COLUMN handicap_allowance DECIMAL(5,2);
