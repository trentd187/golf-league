# CLAUDE.md — Instructions for AI Assistant

This file provides instructions and context to ensure consistent, high-quality contributions to this project across sessions.

## Keeping This File Updated

**This file must be kept current.** After every session where a meaningful decision is made, update this file before finishing. Do not wait to be asked.

Update CLAUDE.md when any of the following occur:
- A new dependency is added to either the backend or mobile app
- A new architectural pattern is introduced (new handler structure, new state management pattern, etc.)
- A convention is changed or refined (e.g., switching libraries, changing naming rules)
- A new directory or layer is added to the project structure
- A known quirk, workaround, or gotcha is discovered
- A data model decision is revised
- A new environment variable is added

When updating, **edit the relevant existing section** rather than appending a new one — keep the file organized and non-redundant. Remove or replace outdated information rather than leaving both old and new side by side.

## Project Overview

**Golf Stuff In Here** is a mobile-first golf league and tournament management app.
- **Backend:** Go + Fiber v2 API server with WebSockets, deployed on AWS ECS via Docker
- **Mobile:** React Native + Expo **SDK 54** (TypeScript), distributed via App Store / Google Play
- **Database:** PostgreSQL 16 with golang-migrate SQL migrations
- **Auth:** Clerk (Google OAuth + Email OTP; sign-in and sign-up share one screen with email OTP fallback to sign-up)
- **Module path:** `github.com/trentd187/golf-league`

> **SDK 54 pinned** — Expo Go on the Play Store is SDK 54. Do not upgrade to SDK 55 without verifying Expo Go compatibility.

The user is **learning TypeScript** and has **intermediate Go knowledge**. Always add thorough explanatory comments to every file touched.

---

## Universal Rules

### Comments Are Required
Every file must have comments. This is non-negotiable. The user is learning and relies on comments to understand the code.

- **File-level comment** at the top of every file explaining its purpose and role in the system
- **Section comments** before logical groupings of code
- **Inline comments** on any line that isn't immediately obvious
- For Go: use `//` comments
- For TypeScript/TSX: use `//` and `{/* */}` (in JSX)
- For SQL: use `--` comments
- For config files (JS): use `//` comments

### No Unexplained Magic
If a library, pattern, or language feature is non-obvious, explain it. Examples:
- Why `_` discards a value in Go
- What `??` (nullish coalescing) does in TypeScript
- What a GORM struct tag like `uniqueIndex:idx_name` means
- What `go hub.Run()` does (goroutine)

---

## Environment / Shell

- Shell: **Git Bash** on Windows 11
- Node.js is installed but **not on the Git Bash PATH** by default. Prefix Node commands with:
  ```bash
  export PATH="/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm:$PATH"
  ```
- Go is available in Git Bash without a PATH workaround
- Working directory: `/c/Users/trent/git-repos/golf-league`

---

## Backend (Go)

### Package Structure

```
backend/
├── cmd/server/main.go         # Entry point only — no business logic
├── internal/config/           # Config struct loaded from env vars
├── internal/database/         # DB connection + migration runner
├── internal/handlers/         # HTTP handlers, one file per domain (e.g., events.go, users.go)
├── internal/middleware/       # auth.go (JWT) and roles.go (RBAC)
├── internal/models/           # All GORM models in models.go
├── internal/services/         # Business logic (to be added — keep handlers thin)
├── internal/websocket/        # WebSocket hub
└── migrations/                # SQL migration files
```

### Adding a New Handler

1. Create the handler function in `internal/handlers/<domain>.go`
2. Register the route in `cmd/server/main.go`
3. Apply middleware as needed: `middleware.Auth(cfg)` then `middleware.RequireRole(...)`

Handler signature always follows Fiber's pattern:
```go
func HandlerName(c *fiber.Ctx) error {
    // read from c.Params(), c.Body(), c.Locals()
    // return c.JSON(...) or c.Status(...).JSON(...)
}
```

### Adding a New Model

Add the struct to `internal/models/models.go`. Then create a new migration to add the table to the database — **never use GORM AutoMigrate** in production code.

### Migration Conventions

- Files live in `backend/migrations/`
- Naming: `000002_description.up.sql` and `000002_description.down.sql`
- Increment the sequence number from the last migration
- Never edit a migration that has already been applied — create a new one instead
- The down migration must exactly reverse the up migration

### Role Enforcement Pattern

Apply middleware to routes in this order:
```go
// 1. Parse and validate the Clerk JWT
app.Use(middleware.Auth(cfg))

// 2. Restrict by role (apply per-route or per-group)
app.Post("/events", middleware.RequireRole("admin", "manager"), handlers.CreateEvent)
```

The three roles are: `admin`, `manager`, `user`. See the permissions matrix in the data model documentation or `internal/models/models.go`.

### Score Entry Permission Check

Score mutation endpoints must check that the requesting user is a member of the same playing group as the target `round_player`. This is more granular than role checking — it must be done in the handler or a dedicated `RequireGroupMember()` middleware (stub is in `middleware/roles.go`).

### Environment Variables

All config is read in `internal/config/config.go`. To add a new variable:
1. Add the field to the `Config` struct
2. Read it with `os.Getenv("VAR_NAME")` in `Load()`
3. Add it to `backend/.env.example` with a description comment

---

## Mobile (React Native + Expo)

### Package Manager

**Always use `pnpm`** in the `mobile/` directory. Never use `npm install`.

```bash
# Correct
pnpm install
pnpm add some-package

# Wrong — do not use
npm install
npm install some-package
```

### Adding a New Screen

Create a `.tsx` file in the `app/` directory. The file path determines the route:

```
app/events/[id].tsx        →  /events/:id  (stack screen, no tab bar)
app/(tabs)/events.tsx      →  /events      (tab screen)
app/(tabs)/scores.tsx      →  new tab screen
```

Every new screen file needs:
1. A file-level comment explaining what it does
2. A default export of a React component
3. NativeWind `className` for styling (no StyleSheet)

### Styling with NativeWind

Always use NativeWind `className` — never use `StyleSheet.create()` or inline `style={{}}` objects:

```tsx
// Correct
<View className="flex-1 items-center justify-center bg-white p-4">

// Wrong — don't use StyleSheet or inline styles
<View style={{ flex: 1, alignItems: 'center' }}>
```

Primary brand color is **green-700** (`#15803d`). Secondary actions use gray. Errors use red-600.

### Theme System

The app supports 3 switchable themes (Light, Dark, Grey/neutral) persisted across restarts in SecureStore. **All new screens and components must use theme tokens, not hardcoded color classes.**

**Architecture — three layers:**

| Layer | File | Role |
|---|---|---|
| Data | `themes/index.ts` | 4 static theme objects with all Tailwind class strings as literals |
| State | `stores/themeStore.ts` | Zustand `persist` store; saves only `themeName`, derives full `Theme` object |
| Consumption | `hooks/useTheme.ts` | `useTheme()` hook used in every screen/component |

**Usage pattern in every screen and component:**
```tsx
import { useTheme } from "@/hooks/useTheme";

function MyScreen() {
  const t = useTheme();
  return (
    <View className={`flex-1 ${t.screen}`}>
      <Text className={t.textPrimary}>Hello</Text>
    </View>
  );
}
```

**Theme slots (use these, not hardcoded classes):**

| Slot | Purpose |
|---|---|
| `t.screen` | Full-page `View` background |
| `t.surface` | Cards, modals, bottom sheets |
| `t.surfaceSunken` | `TextInput` background (inset feel) |
| `t.border` | Card/container border |
| `t.divider` | `border-b` between list rows |
| `t.borderInput` | `TextInput` border |
| `t.textPrimary` | Headings, important text |
| `t.textSecondary` | Body/supporting text |
| `t.textTertiary` | Muted hints, form labels, section labels |
| `t.primaryBg` | Primary action button background |
| `t.primaryBgDisabled` | Primary button while loading/pending |
| `t.colors.tabBarActive` | Hex — for `Ionicons color`, `ActivityIndicator color`, inline styles |
| `t.colors.tabBarInactive` | Hex — for secondary icons, `placeholderTextColor` |

**Tailwind JIT constraint — critical rule:** All Tailwind class strings must exist as **literal text** in scanned source files. `themes/index.ts` holds all the literal class strings and is included in the `tailwind.config.js` content paths. Never construct class names dynamically (e.g., no `` `text-${color}-500` ``). At runtime, components simply pick which pre-scanned string to use.

**`placeholderTextColor` on every `TextInput`:** NativeWind can't control placeholder color via `className`. Always add:
```tsx
<TextInput
  className={`... ${t.textPrimary}`}
  placeholderTextColor={t.colors.tabBarInactive}
/>
```

**`Ionicons` and `ActivityIndicator` always need hex:** Use `color={t.colors.tabBarActive}` or `color={t.colors.tabBarInactive}`.

**Inline style required for themed hex on `Text`:** When a `Text`'s color must be a dynamic hex (e.g., "Done" button in iOS date picker), use:
```tsx
// eslint-disable-next-line react-native/no-inline-styles
<Text style={{ color: t.colors.tabBarActive }}>Done</Text>
```

**What is NEVER themed (always hardcoded categorical/brand colors):**
- Event type badge colors (league=blue, tournament=amber, casual=gray)
- Status chip colors (upcoming=sky, active=green, completed=gray, cancelled=red)
- Role badge colors (organizer=green-100/green-700)
- Round status chip colors
- OAuth buttons (Google/Facebook/Apple brand colors)
- Sign-out button (always `bg-red-50 border-red-200 text-red-600`)
- Error text/borders (always `text-red-500` / `border-red-400`)
- Member initials avatars (always `bg-green-100 text-green-700`)
- App title "Golf Stuff In Here" (always `text-green-700`)
- `bg-black/40` modal backdrop overlay

**Theme switching UI** lives in `app/(tabs)/profile.tsx` — a "Theme" section with 4 pill buttons using `THEME_META` from `themes/index.ts` and `useThemeStore` from `stores/themeStore.ts`:
```tsx
import { useThemeStore } from "@/stores/themeStore";
import { THEME_META } from "@/themes";

// IMPORTANT: use two separate calls, not one selector returning an object.
// A selector like (s) => ({ themeName: s.themeName, setTheme: s.setTheme }) creates
// a new object on every render, which breaks React 19's useSyncExternalStore caching
// and causes an infinite re-render loop.
const themeName = useThemeStore((s) => s.themeName);
const setTheme  = useThemeStore((s) => s.setTheme);
```

### API Calls

Use TanStack Query (`useQuery` / `useMutation`) and the `API_URL` from `constants/api.ts`:

```tsx
import { useQuery, useMutation } from "@tanstack/react-query";
import { API_URL } from "@/constants/api";

// Fetching data
const { data } = useQuery({
  queryKey: ["events"],
  queryFn: () => fetch(`${API_URL}/api/v1/events`).then(r => r.json()),
});

// Mutating data
const mutation = useMutation({
  mutationFn: (newEvent) =>
    fetch(`${API_URL}/api/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newEvent),
    }).then(r => r.json()),
});
```

### State Management

- **Server state** (API data): TanStack Query
- **Client/UI state** (modals open, form inputs, etc.): Zustand stores in `stores/`
- **Theme state**: `stores/themeStore.ts` — persisted to SecureStore; access via `useTheme()` hook
- **Auth state**: Clerk hooks (`useAuth`, `useUser`)

### Adding a New Expo Package

Use `npx expo install` for packages with native modules (it picks the SDK-compatible version):
```bash
export PATH="/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm:$PATH"
npx expo install expo-camera
```

Use `pnpm add` for pure JS packages:
```bash
pnpm add some-js-library
```

### File Upload from React Native (Profile Image Pattern)

React Native's `BlobManager` has fundamental limitations that affect file uploads. These are **React Native core issues**, not Expo-specific, and may or may not be resolved in SDK 55 / React Native 0.77+:

- `fetch(file://).blob()` returns a `Blob` with `type: ""` (empty MIME type)
- `new Blob([arrayBuffer])` throws "Creating blobs from ArrayBuffer not supported"
- `new Blob([rawBlob], { type })` re-wraps without crashing, but Clerk's SDK still silently drops the upload

**The correct pattern** for uploading a local file from React Native is to use FormData with React Native's native file entry format. The native networking layer reads the `file://` URI at the OS level and streams it directly, bypassing BlobManager entirely:

```tsx
const formData = new FormData();
formData.append("file", {
  uri: asset.uri,   // file:// URI — RN native layer reads this directly
  type: mimeType,   // explicit MIME type
  name: `photo.jpg`,
} as any); // "as any" because TS FormData types don't include RN's extended format

// Do NOT set Content-Type manually — RN sets multipart/form-data boundary automatically
await fetch(uploadUrl, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: formData,
});
```

This pattern is used in `app/(tabs)/profile.tsx` to upload to our backend (`PATCH /api/v1/me/profile-image`), which proxies to Clerk's Backend API using the secret key.

**Do NOT call Clerk's Frontend API directly from React Native.** It uses browser-cookie auth and will return "Unable to authenticate this browser" for native clients. The correct pattern is:
- Mobile → our backend (JWT auth) → Clerk Backend API (secret key auth)
- Handler: `handlers.UpdateProfileImage` in `backend/internal/handlers/users.go`

**Clerk session after background/foreground transitions:** When a native UI (image picker, camera, share sheet, etc.) opens, the app goes to the background. On some versions of Expo Go + Clerk Expo SDK, this resets Clerk's in-memory session state. Calling `getToken()` _after_ the native UI closes may throw "You are signed out" even though the user is still authenticated. Fix: always call `getToken()` **before** opening the native UI, while the app is in the foreground.

**TODO when upgrading to SDK 55:** Test whether `user.setProfileImage()` works correctly with SDK 55 / React Native 0.77+. If blob handling is fixed in the new architecture, we could simplify back to the SDK method. Until confirmed, keep the direct FormData API call approach.

---

### Known Dependency Quirks (SDK 54)

pnpm's strict resolution requires the following packages to be **direct dependencies** (not just transitive). Without them, either the bundler fails or the wrong version is loaded at runtime:

| Package | Version | Why direct dep is needed |
|---|---|---|
| `@expo/metro-runtime` | `~6.1.2` | expo-router 6.0.23 imports it directly; without it: `Unable to resolve "@expo/metro-runtime/error-overlay"` |
| `react-native-css-interop` | `latest` | NativeWind peer dep not auto-hoisted |
| `expo-web-browser` | `~15.0.10` | Clerk OAuth peer dep |
| `expo-auth-session` | `~7.0.10` | Without this, pnpm resolves clerk's peer to 55.0.6 (SDK 55) → `expo-crypto@55.0.8` → `Cannot find native module 'ExpoCryptoAES'` crash |
| `expo-crypto` | `~15.0.8` | SDK 54 compatible version; 55.x is SDK 55 only |
| `expo-image-picker` | `~17.0.10` | Profile photo upload; installed via `npx expo install expo-image-picker` |
| `@react-native-community/datetimepicker` | `8.4.4` | Native date picker used by `components/DateInput.tsx`; installed via `npx expo install @react-native-community/datetimepicker` |

**Important:** pnpm `overrides` do NOT work for peer dependency resolution — you must add the package as a direct `dependency` to control what version peer-dependent packages get.

After any package.json change, run `pnpm start --clear` to flush Metro's cache.
`npx expo install --fix` resolves correct SDK-54-compatible versions for all expo packages.

### Reusable Components

Shared UI components live in `mobile/components/`. Import them with the `@/` alias:
```tsx
import DateInput, { apiToDisplay, displayToApi } from "@/components/DateInput";
```

**`DateInput`** (`components/DateInput.tsx`) — date field with auto-formatting and native picker:
- Displays and stores dates in `MM-DD-YY` format in form state
- Auto-inserts dashes as the user types (no manual dash entry needed)
- Calendar icon button opens the platform's native date picker (Android: dialog, iOS: bottom-sheet modal)
- Inline red border + error message when a fully-typed date is invalid
- Use `apiToDisplay("YYYY-MM-DD")` → `"MM-DD-YY"` when pre-filling from API data
- Use `displayToApi("MM-DD-YY")` → `"YYYY-MM-DD"` when sending to the API

**`ModalHeader`** (`components/ModalHeader.tsx`) — standard title + close (✕) row for all modal sheets:
- Props: `title`, `onClose`, `disabled?` (disables close button while a mutation is pending)
- Use this in every Modal — do not re-implement the header inline

**`SectionHeader`** (`components/SectionHeader.tsx`) — bold section title with optional "+ Action" button:
- Props: `title`, `actionLabel`, `onAction`, `showAction` (pass `false` to hide button for non-organizers)
- Used for "Members", "Rounds", and future sections in detail screens

**`UserSearchList`** (`components/UserSearchList.tsx`) — search box + user list for picking a user to add:
- Props: `users` (pre-filtered, `undefined` = loading), `search`, `onSearchChange`, `onSelect`, `isPending`, `emptyMessage?`
- Parent is responsible for fetching users and filtering out already-added IDs
- Parent owns the `search` state so it can reset it when the modal closes
- Also exports the `UserSummary` type for typing query data in parent screens

**`badges.tsx`** (`components/badges.tsx`) — categorical badge and chip components (hardcoded colors):
- `EventTypeBadge` — league (blue), tournament (amber), casual (gray)
- `StatusChip` — event lifecycle: upcoming (sky), active (green), completed (gray), cancelled (red)
- `RoleBadge` — "Organizer" pill; renders `null` for players (safe to always include)
- `RoundStatusChip` — round lifecycle: scheduled (sky), active (green), completed (gray)

### TypeScript Path Aliases

The `@/` alias resolves to the `mobile/` root. Use it for all internal imports:
```tsx
import { tokenCache } from "@/utils/cache";   // correct
import { tokenCache } from "../../utils/cache"; // avoid relative paths
```

---

## Mobile Code Quality Rules

These rules prevent recurring issues that make files large and hard to maintain.

### Only destructure what you use from hooks

Unused destructured variables cause TypeScript warnings and mislead future readers.
```tsx
// Wrong — refetchRounds is declared but never called anywhere
const { data: rounds, isLoading: roundsLoading, refetch: refetchRounds } = useQuery(...);

// Correct — only destructure what the component actually uses
const { data: rounds, isLoading: roundsLoading } = useQuery(...);
```

### No copy-pasted JSX blocks

If the same JSX block appears more than once in a file, extract it. Two options:

**If it renders independently → extract a component:**
```tsx
// Wrong — same pill JSX copy-pasted twice in the same render
<View className="flex-row gap-2">{FORMATS.slice(0, 2).map(...)}</View>
<View className="flex-row gap-2">{FORMATS.slice(2).map(...)}</View>

// Correct — single loop using a chunk() helper to create rows
{chunk(FORMATS, 2).map((row, i) => (
  <View key={i} className="flex-row gap-2">{row.map(renderPill)}</View>
))}
```

**If it's a repeated structural pattern → extract to `components/`** (see below).

### Sub-components that could be needed elsewhere go in `components/`

Do not define UI sub-components at the top of a screen file if they will be (or might be) needed by another screen. File-local components that belong in `components/`:
- Display atoms used on multiple screens (badges, chips, status labels)
- Structural patterns repeated across screens (`ModalHeader`, `SectionHeader`)
- Picker/search patterns that will be reused (`UserSearchList`)

Rule of thumb: if you'd have to copy-paste it when building the next screen, extract it now.

### Cards that lead somewhere must be `TouchableOpacity`

Any card that will eventually navigate to a detail or edit screen must be a `TouchableOpacity` from the start, even if the destination screen doesn't exist yet. Use `router.push()` with the future route so the navigation intention is clear:
```tsx
// Correct — tappable with forward-looking route, even before the screen is built
<TouchableOpacity
  onPress={() => router.push(`/rounds/${round.id}`)}
  activeOpacity={0.7}
>
  ...round card content...
</TouchableOpacity>
```
Expo Router shows an "Unmatched Route" page in development for routes that don't have a file yet — this is expected and harmless.

### Always use shared components for common patterns

| Pattern | Use |
|---|---|
| Modal title + close button | `ModalHeader` from `@/components/ModalHeader` |
| Section heading + "+ Action" button | `SectionHeader` from `@/components/SectionHeader` |
| User search + add list | `UserSearchList` from `@/components/UserSearchList` |
| Status/type/role pills | Named exports from `@/components/badges` |
| Date input with picker | `DateInput` from `@/components/DateInput` |

---

## Data Model

The full data model is documented in `DATA_MODEL.md` (repo root), `backend/internal/models/models.go`,
and `backend/migrations/000001_initial_schema.up.sql`.

There is **no separate `leagues` table**. An `event` with `event_type = 'league'` IS the league.
This keeps the hierarchy simple — event → rounds → scores, regardless of competition type.

Key hierarchy:
```
users
events (type: "league" | "tournament" | "casual")
  → event_players (role: "organizer" | "player")
  → event_points_rules
  → rounds → round_players → scores
           → groups → group_players → round_players
           → teams → team_members → round_players
                   → team_scores
courses → tees → holes
```

**Who can manage a specific event** (edit, invite members, schedule rounds) — two-tier check:
- `admin` global role → can manage any event (full platform bypass)
- `manager` global role → only events where `event_players.role = 'organizer'` for that event (i.e., events they created, or where another organizer has explicitly granted them the organizer role)
- `user` global role → same rule as manager

The creator is auto-added as organizer in the `POST /api/v1/events` transaction.
This check is implemented in `isEventOrganizer()` in `handlers/events.go` — use it in every handler that modifies an event.

### Handicap Rule

- `rounds.requires_handicap = true` → score entry is blocked until the player's `round_players.handicap_index` is set
- Course handicap formula: `ROUND(handicap_index × (slope_rating / 113) + (course_rating - par))`
- Enforced at the API layer (not at the database level) on score mutation routes

### Finish Position

Tracked at two levels:
- `round_players.finish_position` — within a single round
- `event_players.finish_position` — across the whole event

Both are `nullable INT`, set programmatically when a round or event is marked `completed`.

---

## Docker

- `docker-compose.yml` at the repo root starts PostgreSQL and the backend together
- The backend waits for the database healthcheck before starting (`depends_on: condition: service_healthy`)
- Migrations run automatically on every server startup via `database.RunMigrations()`
- The Dockerfile uses a multi-stage build: `golang:1.24-alpine` to build, `alpine:latest` to run

---

## Git Conventions

- Branch from `main` for new features
- Commit messages should be concise and describe the "why" not just the "what"
- Do not commit `.env` files — they are in `.gitignore`
