// types/courses.ts
// Shared TypeScript interfaces for course, tee, and hole data.
// Used by the course list tab, course detail screen, and HoleDataGrid component.
// These mirror the JSON shapes returned by GET /api/v1/courses and GET /api/v1/courses/:id.

export interface HoleRow {
  hole_number: number;
  par: number;
  stroke_index: number;
  yardage: number | null;
}

export interface TeeDetail {
  id: string;
  name: string;
  course_rating: number;
  slope_rating: number;
  par: number;
  holes: HoleRow[];
}

// CourseDetail is the full response from GET /api/v1/courses/:id.
// has_holes is true when at least one tee has all holes populated.
export interface CourseDetail {
  id: string;
  name: string;
  city: string;
  state: string;
  hole_count: number;
  has_holes: boolean;
  external_source: string;
  tees: TeeDetail[];
}

// CourseSummary is one row in GET /api/v1/courses (list endpoint).
export interface CourseSummary {
  id: string;
  name: string;
  city: string;
  state: string;
  hole_count: number;
  tee_count: number;
  has_holes: boolean;
}
