-- Add nine_hole_selection to rounds to support playing just 9 holes on an 18-hole course.
-- "front" = holes 1–9, "back" = holes 10–18, NULL = full round (all holes).
ALTER TABLE rounds ADD COLUMN nine_hole_selection TEXT NULL;
