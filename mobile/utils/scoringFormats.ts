// utils/scoringFormats.ts
// Single source of truth for scoring format values and display labels.
// Both the Schedule Round form (events/[id].tsx) and Edit Round form (rounds/[id].tsx)
// import from here so the list never diverges between the two screens.

export const SCORING_FORMATS: { value: string; label: string }[] = [
  { value: "stroke",                  label: "Stroke" },
  { value: "stableford",              label: "Stableford" },
  { value: "irish_rumble",            label: "Irish Rumble (Stroke)" },
  { value: "irish_rumble_stableford", label: "Irish Rumble (Stableford)" },
  { value: "scramble",                label: "Scramble" },
  { value: "match_play",              label: "Match Play" },
  { value: "las_vegas",               label: "Las Vegas" },
  { value: "best_ball",               label: "Best Ball" },
];

// formatLabel converts a scoring_format DB value to a human-readable label.
// Falls back to the raw value if it's not in the list (e.g. after a future migration).
export function formatLabel(value: string): string {
  return SCORING_FORMATS.find((f) => f.value === value)?.label ?? value;
}

// formatToPar: converts a score-vs-par integer to a display string ("E", "+2", "-3").
// Returns "—" for null (no par data on this course).
export function formatToPar(toPar: number | null): string {
  if (toPar === null) return "—";
  if (toPar === 0) return "E";
  return toPar > 0 ? `+${toPar}` : `${toPar}`;
}
