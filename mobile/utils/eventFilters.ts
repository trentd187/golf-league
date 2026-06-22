// utils/eventFilters.ts
// Pure filter + sort helpers for the Events list (app/(tabs)/events.tsx).
//
// Extracted from the screen so the logic is unit-tested and counts toward
// coverage (screen files are excluded from the coverage set — see CLAUDE.md
// "extract-first rule"). The screen calls filterEvents() then sortEvents().
//
// Both functions are generic over T so the screen's full EventResponse type
// flows through unchanged — they only read the fields declared on FilterableEvent.

export type EventTypeFilter = "all" | "league" | "tournament" | "casual";

// Only "active" and "completed" are valid event statuses (cancel was removed).
export type EventStatusFilter = "all" | "active" | "completed";

export type EventSortKey =
  | "start_date_asc"
  | "start_date_desc"
  | "name_asc"
  | "members_desc"
  | "created_desc";

// The minimal shape filterEvents/sortEvents need. EventResponse satisfies this.
export interface FilterableEvent {
  event_type: "league" | "tournament" | "casual";
  status: string;
  start_date: string | null; // "YYYY-MM-DD" or null
  name: string;
  member_count: number;
  created_at: string;
}

// filterEvents narrows by type and status. "all" means no constraint for that axis.
export function filterEvents<T extends FilterableEvent>(
  events: T[],
  typeFilter: EventTypeFilter,
  statusFilter: EventStatusFilter,
): T[] {
  let result = typeFilter === "all" ? events : events.filter((e) => e.event_type === typeFilter);
  if (statusFilter !== "all") {
    result = result.filter((e) => e.status === statusFilter);
  }
  return result;
}

// sortEvents returns a NEW array — Array.sort() mutates in place and we must not
// mutate the React Query cache the screen passes in.
export function sortEvents<T extends FilterableEvent>(events: T[], sortKey: EventSortKey): T[] {
  const sorted = [...events];

  switch (sortKey) {
    case "start_date_asc":
      sorted.sort((a, b) => compareNullableDate(a.start_date, b.start_date, "asc"));
      break;
    case "start_date_desc":
      sorted.sort((a, b) => compareNullableDate(a.start_date, b.start_date, "desc"));
      break;
    case "name_asc":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "members_desc":
      sorted.sort((a, b) => b.member_count - a.member_count);
      break;
    case "created_desc":
      // ISO timestamps compare correctly as plain strings.
      sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
      break;
  }

  return sorted;
}

// compareNullableDate keeps null dates last regardless of direction, so events
// without a start date never push above scheduled ones when sorting descending.
function compareNullableDate(a: string | null, b: string | null, dir: "asc" | "desc"): number {
  if (!a && !b) return 0;
  if (!a) return 1; // nulls last
  if (!b) return -1;
  return dir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
}
