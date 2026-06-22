# Reusable Components

Shared UI components live in `mobile/components/`. Import with the `@/` alias.

## Always use shared components for these patterns

| Pattern | Use |
|---|---|
| Modal title + close button | `ModalHeader` from `@/components/ModalHeader` |
| Section heading + "+ Action" button | `SectionHeader` from `@/components/SectionHeader` |
| User search + add list | `UserSearchList` from `@/components/UserSearchList` |
| Status/type/role pills | Named exports from `@/components/badges` |
| Date input with picker | `DateInput` from `@/components/DateInput` |
| Filter + Sort bar / sheets on a list screen | `FilterSortBar` + `FilterSheet` + `SortSheet` |

## Component catalog

**`DateInput`** (`components/DateInput.tsx`) — date field with auto-formatting and native picker:
- Displays/stores dates in `MM-DD-YY` format in form state; auto-inserts dashes as the user types
- Calendar icon button opens platform native date picker (Android: dialog, iOS: bottom-sheet modal)
- Inline red border + error message when a fully-typed date is invalid
- Helpers: `apiToDisplay("YYYY-MM-DD")` → `"MM-DD-YY"` and `displayToApi("MM-DD-YY")` → `"YYYY-MM-DD"`

**`ModalHeader`** — standard title + close (✕) row for all modal sheets.
- Props: `title`, `onClose`, `disabled?` (disables close button while a mutation is pending)

**`SectionHeader`** — bold section title with optional "+ Action" button.
- Props: `title`, `actionLabel`, `onAction`, `showAction` (pass `false` to hide for non-organizers)

**`UserSearchList`** — search box + user list for picking a user to add.
- Props: `users` (pre-filtered, `undefined` = loading), `search`, `onSearchChange`, `onSelect`, `isPending`, `emptyMessage?`
- Parent fetches users and filters out already-added IDs; parent owns `search` state to reset on close
- Exports `UserSummary` type

**`badges.tsx`** — categorical badge and chip components (hardcoded colors):
- `EventTypeBadge` — league (blue), tournament (amber), casual (gray)
- `StatusChip` — event lifecycle: upcoming (sky), active (green), completed (gray), cancelled (red)
- `RoleBadge` — "Organizer" pill; renders `null` for players
- `RoundStatusChip` — round lifecycle: scheduled (sky), active (green), completed (gray)

**`CoursePickerModal`** — full-screen modal for searching/selecting a course.
- Local-first search (GET /courses?name=...), external on-demand ("Search Online"), auto-import on select
- Returns `PickedCourse` (id, name, city, state, has_holes, tees[]) via `onSelect`
- `has_holes: bool` — true when at least one tee has complete hole data; parent uses this to show a warning

**`HoleDataGrid`** — 18-hole scorecard grid for a single tee.
- Props: `courseId`, `teeId`, `holes`, `editable`, `onSaved?`
- Display: read-only table (hole #, par, SI, yards) with totals row
- Edit (admin/manager): `TextInput` per cell; validates par (3–6), SI (1–18, unique), saves via `PUT /tees/:teeId/holes`

**`TeeForm`** — modal sheet for creating/editing a tee set.
- Props: `courseId`, `existing?` (null = create), `onSaved`
- Fields: name, course rating, slope rating, par (gender omitted; backend defaults to "unisex")

**Filter + Sort controls** — shared by the Events and Rounds list tabs so both behave identically:
- `FilterSortBar` — the Filter + Sort trigger row. Props: `hasActiveFilters`, `sortLabel` (short label), `onOpenFilter`, `onOpenSort`. Filter button turns green when any filter is active.
- `FilterSheet` — generic bottom-sheet filter. Props: `visible`, `onClose`, `sections` (`FilterSheetSection[]` — each `{ key, title, options, selected, onSelect }`, single-select), `onClearAll`, `showClearIcon`.
- `SortSheet` — generic bottom-sheet sort. Props: `visible`, `onClose`, `options` (`{ value, label }[]`; extra fields like `shortLabel` are ignored), `selected`, `onSelect` (caller closes + persists).
- The screen owns state; pure filter/sort logic lives in `utils/eventFilters.ts` / `utils/roundFilters.ts` (unit-tested, so it counts toward coverage). The selection is **persisted across sessions** in `stores/listPrefsStore.ts` (SecureStore/localStorage via `persist`, with a sync boot read like `themeStore`) — read the slice with `useListPrefsStore((s) => s.events)` / `s.rounds` and update via `setEventPrefs` / `setRoundPrefs` / `resetEventFilters` / `resetRoundFilters`.

## Shared TypeScript types

Course-related interfaces live in `mobile/types/courses.ts`:
```tsx
import type { CourseDetail, TeeDetail, HoleRow, CourseSummary } from "@/types/courses";
```

| Type | Used by |
|---|---|
| `CourseSummary` | Courses list tab (GET /courses response) |
| `CourseDetail` | Course detail screen (GET /courses/:id response) |
| `TeeDetail` | Course detail, HoleDataGrid, TeeForm |
| `HoleRow` | HoleDataGrid |
