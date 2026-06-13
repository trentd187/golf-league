// __tests__/utils/roundPayload.test.ts
// Unit tests for buildRoundCoursePayload in utils/roundPayload.ts.

import { buildRoundCoursePayload } from "@/utils/roundPayload";
import type { PickedCourse } from "@/components/CoursePickerModal";

const course: PickedCourse = {
  id: "course-uuid-1",
  name: "Augusta National",
  city: "Augusta",
  state: "GA",
  tees: [{ id: "tee-uuid-1", name: "Masters", par: 72, slope_rating: 137, course_rating: 76.2 }],
  has_holes: true,
  hole_count: 18,
};

describe("buildRoundCoursePayload", () => {
  it("uses course_id and default_tee_id when a tee is selected", () => {
    const result = buildRoundCoursePayload(course, "tee-uuid-1", "18", "stroke");
    expect(result).toEqual({
      scoring_format: "stroke",
      course_id: "course-uuid-1",
      default_tee_id: "tee-uuid-1",
    });
  });

  it("falls back to course_name when no tee is selected", () => {
    const result = buildRoundCoursePayload(course, null, "18", "stroke");
    expect(result).toEqual({
      scoring_format: "stroke",
      course_name: "Augusta National",
    });
  });

  it("omits nine_hole_selection for full 18", () => {
    const result = buildRoundCoursePayload(course, "tee-uuid-1", "18", "stroke");
    expect(result.nine_hole_selection).toBeUndefined();
  });

  it("includes nine_hole_selection for front 9", () => {
    const result = buildRoundCoursePayload(course, "tee-uuid-1", "front", "stroke");
    expect(result.nine_hole_selection).toBe("front");
    expect(result.course_id).toBe("course-uuid-1");
  });

  it("includes nine_hole_selection for back 9 with no tee", () => {
    const result = buildRoundCoursePayload(course, null, "back", "stableford");
    expect(result.nine_hole_selection).toBe("back");
    expect(result.scoring_format).toBe("stableford");
    expect(result.course_name).toBe("Augusta National");
    expect(result.course_id).toBeUndefined();
  });

  it("passes through the scoring_format value", () => {
    for (const fmt of ["stroke", "stableford", "match", "skins", "scramble"]) {
      const result = buildRoundCoursePayload(course, null, "18", fmt);
      expect(result.scoring_format).toBe(fmt);
    }
  });

  it("includes vegas toggles only for a las_vegas round", () => {
    const result = buildRoundCoursePayload(course, "tee-uuid-1", "18", "las_vegas", {
      birdieFlip: false,
      scoringBasis: "net",
    });
    expect(result.vegas_birdie_flip).toBe(false);
    expect(result.vegas_scoring_basis).toBe("net");
  });

  it("omits vegas toggles for non-vegas formats even when supplied", () => {
    const result = buildRoundCoursePayload(course, "tee-uuid-1", "18", "stroke", {
      birdieFlip: true,
      scoringBasis: "gross",
    });
    expect(result.vegas_birdie_flip).toBeUndefined();
    expect(result.vegas_scoring_basis).toBeUndefined();
  });

  it("omits vegas toggles for a las_vegas round when no options are supplied", () => {
    const result = buildRoundCoursePayload(course, "tee-uuid-1", "18", "las_vegas");
    expect(result.vegas_birdie_flip).toBeUndefined();
    expect(result.vegas_scoring_basis).toBeUndefined();
  });
});
