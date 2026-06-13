// hooks/useRoundForm.ts
// Shared form state for round course/tee/format selection.
// Used by both the eventless round create screen (app/rounds/create.tsx) and
// the event schedule-round modal (app/events/[id].tsx) so both surfaces stay
// in sync as the form fields evolve.

import { useState } from "react";
import type { PickedCourse } from "@/components/CoursePickerModal";

export interface RoundFormState {
  selectedCourse: PickedCourse | null;
  selectedTeeId: string | null;
  nineHoleSelection: "18" | "front" | "back";
  scoringFormat: string;
  // Las Vegas toggles — only used when scoringFormat is "las_vegas".
  vegasBirdieFlip: boolean;
  vegasScoringBasis: "gross" | "net";
  coursePickerVisible: boolean;
  setSelectedCourse: (c: PickedCourse | null) => void;
  setSelectedTeeId: (id: string | null) => void;
  setNineHoleSelection: (v: "18" | "front" | "back") => void;
  setScoringFormat: (v: string) => void;
  setVegasBirdieFlip: (v: boolean) => void;
  setVegasScoringBasis: (v: "gross" | "net") => void;
  setCoursePickerVisible: (v: boolean) => void;
  // resetForm: clears all course/tee/format state back to defaults.
  // Call on modal close, form submit, or course clear.
  resetForm: () => void;
}

export function useRoundForm(): RoundFormState {
  const [selectedCourse, setSelectedCourse] = useState<PickedCourse | null>(null);
  const [selectedTeeId, setSelectedTeeId] = useState<string | null>(null);
  const [nineHoleSelection, setNineHoleSelection] = useState<"18" | "front" | "back">("18");
  const [scoringFormat, setScoringFormat] = useState("stroke");
  const [vegasBirdieFlip, setVegasBirdieFlip] = useState(true);
  const [vegasScoringBasis, setVegasScoringBasis] = useState<"gross" | "net">("gross");
  const [coursePickerVisible, setCoursePickerVisible] = useState(false);

  const resetForm = () => {
    setSelectedCourse(null);
    setSelectedTeeId(null);
    setNineHoleSelection("18");
    setScoringFormat("stroke");
    setVegasBirdieFlip(true);
    setVegasScoringBasis("gross");
  };

  return {
    selectedCourse,
    selectedTeeId,
    nineHoleSelection,
    scoringFormat,
    vegasBirdieFlip,
    vegasScoringBasis,
    coursePickerVisible,
    setSelectedCourse,
    setSelectedTeeId,
    setNineHoleSelection,
    setScoringFormat,
    setVegasBirdieFlip,
    setVegasScoringBasis,
    setCoursePickerVisible,
    resetForm,
  };
}
