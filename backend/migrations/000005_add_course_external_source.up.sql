-- Add external API provenance tracking to courses.
-- external_source identifies which API the data came from (e.g. 'golfcourseapi').
-- external_id is the course's ID in that external system.
-- Both default to '' (empty string) for manually-entered courses.
ALTER TABLE courses
  ADD COLUMN external_source VARCHAR NOT NULL DEFAULT '',
  ADD COLUMN external_id     VARCHAR NOT NULL DEFAULT '';

-- Composite index so we can quickly check whether a given external course already exists.
CREATE INDEX idx_courses_external ON courses(external_source, external_id);
