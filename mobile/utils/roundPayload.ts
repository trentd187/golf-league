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
  // Las Vegas toggles — included only when scoring_format is "las_vegas".
  vegas_birdie_flip?: boolean;
  vegas_scoring_basis?: string;
}

// VegasOptions carries the Las Vegas toggle state into the payload builder.
export interface VegasOptions {
  birdieFlip: boolean;
  scoringBasis: "gross" | "net";
}

// buildRoundCoursePayload: converts selected course/tee/format state into the
// API payload fields shared by POST /api/v1/rounds and POST /api/v1/events/:id/rounds.
// Uses course_id + default_tee_id (preferred) when a tee is selected; falls back
// to course_name (find-or-create path) when the course has no tees configured.
// The vegas toggles are attached only for a las_vegas round so other formats stay clean.
export function buildRoundCoursePayload(
  selectedCourse: PickedCourse,
  selectedTeeId: string | null,
  nineHoleSelection: "18" | "front" | "back",
  scoringFormat: string,
  vegas?: VegasOptions,
): RoundCoursePayload {
  const payload: RoundCoursePayload = {
    scoring_format: scoringFormat,
    ...(nineHoleSelection !== "18" ? { nine_hole_selection: nineHoleSelection } : {}),
  };
  if (scoringFormat === "las_vegas" && vegas) {
    payload.vegas_birdie_flip = vegas.birdieFlip;
    payload.vegas_scoring_basis = vegas.scoringBasis;
  }
  if (selectedTeeId) {
    payload.course_id = selectedCourse.id;
    payload.default_tee_id = selectedTeeId;
  } else {
    payload.course_name = selectedCourse.name;
  }
  return payload;
}
