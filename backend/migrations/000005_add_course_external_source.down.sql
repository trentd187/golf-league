DROP INDEX IF EXISTS idx_courses_external;
ALTER TABLE courses
  DROP COLUMN IF EXISTS external_source,
  DROP COLUMN IF EXISTS external_id;
