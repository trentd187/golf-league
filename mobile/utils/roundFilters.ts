// utils/roundFilters.ts
// Pure filter + sort helpers for the My Rounds list (app/(tabs)/rounds.tsx).
//
// Mirrors utils/eventFilters.ts so both list screens share the same shape of
// logic. Extracted from the screen so it's unit-tested and counts toward
// coverage (screen files are excluded — see CLAUDE.md "extract-first rule").
//
// The screen filters with filterRounds(), partitions the result into the
// Active / Upcoming / Completed sections, then sorts each section with
// sortRounds(). Keeping sort separate lets the screen apply it per section.

export type RoundStatusFilter = "all" | "active" | "scheduled" | "completed";

// "all" | a scoring_format value (e.g. "stroke", "best_ball"). Kept as a plain
// string so new formats from utils/scoringFormats.ts need no change here.
export type RoundFormatFilter = string;

export type RoundSortKey = "date_desc" | "date_asc" | "name_asc" | "course_asc";

// The minimal shape filterRounds/sortRounds need. The screen's MyRound satisfies this.
export interface FilterableRound {
  status: string;
  scoring_format: string;
  scheduled_date: string; // "YYYY-MM-DD"
  name: string;
  course_name: string;
}

// filterRounds narrows by status and scoring format. "all" means no constraint.
export function filterRounds<T extends FilterableRound>(
  rounds: T[],
  statusFilter: RoundStatusFilter,
  formatFilter: RoundFormatFilter,
): T[] {
  let result = statusFilter === "all" ? rounds : rounds.filter((r) => r.status === statusFilter);
  if (formatFilter !== "all") {
    result = result.filter((r) => r.scoring_format === formatFilter);
  }
  return result;
}

// sortRounds returns a NEW array — Array.sort() mutates in place and we must not
// mutate the React Query cache the screen passes in.
export function sortRounds<T extends FilterableRound>(rounds: T[], sortKey: RoundSortKey): T[] {
  const sorted = [...rounds];

  switch (sortKey) {
    case "date_desc":
      // scheduled_date is always present; ISO "YYYY-MM-DD" compares as a string.
      sorted.sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date));
      break;
    case "date_asc":
      sorted.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
      break;
    case "name_asc":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "course_asc":
      sorted.sort((a, b) => a.course_name.localeCompare(b.course_name));
      break;
  }

  return sorted;
}
