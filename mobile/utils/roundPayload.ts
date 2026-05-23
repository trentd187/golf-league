// utils/roundPayload.ts
// Builds the course/tee/nine-hole/scoring portion of a round creation payload.
// Shared between the eventless round create screen and the event schedule-round
// modal so changes to the payload shape propagate to both surfaces automatically.

import type { PickedCourse } from "@/components/CoursePickerModal";

export interface RoundCoursePayload {
  scoring_format: string;
  nine_hole_selection?: string;
  course_id?: string;
  default_tee_id?: string;
  course_name?: string;
}

// buildRoundCoursePayload: converts selected course/tee/format state into the
// API payload fields shared by POST /api/v1/rounds and POST /api/v1/events/:id/rounds.
// Uses course_id + default_tee_id (preferred) when a tee is selected; falls back
// to course_name (find-or-create path) when the course has no tees configured.
export function buildRoundCoursePayload(
  selectedCourse: PickedCourse,
  selectedTeeId: string | null,
  nineHoleSelection: "18" | "front" | "back",
  scoringFormat: string,
): RoundCoursePayload {
  const payload: RoundCoursePayload = {
    scoring_format: scoringFormat,
    ...(nineHoleSelection !== "18" ? { nine_hole_selection: nineHoleSelection } : {}),
  };
  if (selectedTeeId) {
    payload.course_id = selectedCourse.id;
    payload.default_tee_id = selectedTeeId;
  } else {
    payload.course_name = selectedCourse.name;
  }
  return payload;
}
