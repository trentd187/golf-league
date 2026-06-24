# Reusable Components

Shared UI components live in `mobile/components/`. Import with the `@/` alias.

## Always use shared components for these patterns

| Pattern | Use |
|---|---|
| Modal title + close button | `ModalHeader` from `@/components/ModalHeader` |
| Section heading + "+ Action" button | `SectionHeader` from `@/components/SectionHeader` |
| User search + add list | `UserSearchList` from `@/components/UserSearchList` |
| User profile photo / avatar | `UserAvatar` from `@/components/UserAvatar` (never an inline `<Image>`) |
| Status/type/role pills | Named exports from `@/components/badges` |
| Date input with picker | `DateInput` from `@/components/DateInput` |
| Time / tee-time input with picker | `TimeInput` from `@/components/TimeInput` |
| Filter + Sort bar / sheets on a list screen | `FilterSortBar` + `FilterSheet` + `SortSheet` |

## Component catalog

**`DateInput`** (`components/DateInput.tsx`, web variant `DateInput.web.tsx`) — date field with auto-formatting and native picker:
- Displays/stores dates in `MM-DD-YY` format in form state; auto-inserts dashes as the user types (typing works on web too)
- Calendar icon opens the platform date picker — Android dialog, iOS bottom-sheet, **web** browser-native `<input type="date">` via `showPicker()` (a detached `.click()` does not reliably open it)
- Inline red border + error message when a fully-typed date is invalid
- Pure helpers live in `utils/dateInput.ts` (`apiToDisplay`, `displayToApi`, `isValidDisplayDate`, `autoFormat`); `apiToDisplay`/`displayToApi` are re-exported from `@/components/DateInput` for existing call sites

**`TimeInput`** (`components/TimeInput.tsx`, web variant `TimeInput.web.tsx`) — tee-time field, the time analogue of `DateInput`:
- Value is `"HH:MM"` 24-hour (same as the backend and HTML `<input type="time">`); displays `"h:mm AM/PM"`
- Opens the platform time picker — Android dialog, iOS bottom-sheet, **web** browser-native `<input type="time">` via `showPicker()`. `@react-native-community/datetimepicker` has no web support, so the inline picker was previously invisible on web
- Props: `value`, `onChange`, `label?`, `placeholder?`, `pickerTitle?` (iOS sheet header), `disabled?`, `clearable?` (X to clear)
- Pure conversion helpers live in `utils/teeTime.ts` (`teeTimeToDate`, `dateToTeeTime`, `formatTeeTime`, `parseFormattedTeeTime`)

**`ModalHeader`** — standard title + close (✕) row for all modal sheets.
- Props: `title`, `onClose`, `disabled?` (disables close button while a mutation is pending)

**`SectionHeader`** — bold section title with optional "+ Action" button.
- Props: `title`, `actionLabel`, `onAction`, `showAction` (pass `false` to hide for non-organizers)

**`UserSearchList`** — search box + user list for picking a user to add.
- Props: `users` (pre-filtered, `undefined` = loading), `search`, `onSearchChange`, `onSelect`, `isPending`, `emptyMessage?`
- Parent fetches users and filters out already-added IDs; parent owns `search` state to reset on close
- Exports `UserSummary` type
- Renders each row's avatar via `UserAvatar` — do not inline an `<Image>`

**`UserAvatar`** (`components/UserAvatar.tsx`, web variant `UserAvatar.web.tsx`) — circular user photo with an initials fallback. **Always use this for user photos; never an inline `<Image>`.**
- Props: `avatarUrl?`, `displayName` (initial shown when no photo), `size?` (default 36)
- **Web variant uses a native `<img loading="lazy" decoding="async">`** instead of RN-web's eager `<Image>`. Avatars are served full-resolution and the events/rounds detail screens render many via `.map()` in a plain `ScrollView`; decoding them all at once crashed the Chromium renderer (`STATUS_ILLEGAL_INSTRUCTION`). Lazy loading decodes only what's near the viewport.
- **Uploads are downscaled to ≤512px JPEG on both platforms** before storage ([`utils/avatar.ts`](../utils/avatar.ts), shared `fitWithin` + 512px/0.8 constants): web via `resizeImageToJpegBuffer` (canvas re-encode), native via `resizeNativeImageToJpegUri` (expo-image-manipulator `manipulate().resize().renderAsync().saveAsync()`). Supabase image transformations (server-side thumbnails) are **disabled on our plan** — the render endpoint returns `FeatureNotEnabled` — so we cap the bitmap client-side instead. The native cap is a native module → needs an EAS rebuild to reach devices (bundled in Expo Go SDK 54). See [keyboard-and-platform.md](keyboard-and-platform.md) "File upload".
- Existing oversized avatars can be shrunk in place with the one-off [`scripts/reprocess-avatars.mjs`](../../scripts/reprocess-avatars.mjs) (optional; lazy-loading already prevents the crash).

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
