# CLAUDE.md — Instructions for AI Assistant

Project-wide rules and conventions. Reference docs live in [`mobile/docs/`](mobile/docs/) and [`backend/docs/`](backend/docs/) — read them when the task touches those areas.

## When to read which doc

| If the task touches… | Read |
|---|---|
| Theme tokens, NativeWind classes, dark/light mode | [`mobile/docs/themes.md`](mobile/docs/themes.md) |
| Modal sheets, badges, date inputs, picker components | [`mobile/docs/components.md`](mobile/docs/components.md) |
| `package.json`, expo install, dependency upgrade, OAuth/Supabase setup | [`mobile/docs/dependencies.md`](mobile/docs/dependencies.md) |
| Keyboard handling, TextInput chaining, file uploads, KeyboardAvoidingView | [`mobile/docs/keyboard-and-platform.md`](mobile/docs/keyboard-and-platform.md) |
| Backend handler/middleware tests, coverage ratchet, Tier 1/Tier 2 strategy | [`backend/docs/testing.md`](backend/docs/testing.md) |
| Data model, schema, foreign keys | [`DATA_MODEL.md`](DATA_MODEL.md) + `backend/internal/models/models.go` |

## Keeping This File Updated

After every session where a meaningful decision is made, update this file or the relevant doc before finishing. Do not wait to be asked.

Update CLAUDE.md (or a `docs/` file) when:
- A new dependency is added
- A new architectural pattern is introduced
- A convention is changed or refined
- A new directory or layer is added
- A known quirk, workaround, or gotcha is discovered
- A data model decision is revised
- A new environment variable is added

Edit the relevant existing section rather than appending. Remove outdated info — don't leave old and new side by side. **If a topic has its own doc under `mobile/docs/` or `backend/docs/`, update that doc, not CLAUDE.md.**

**Size threshold — keep CLAUDE.md tight.** If you'd add more than ~20 lines, a table with more than ~5 rows, or any code example longer than ~5 lines to CLAUDE.md, the topic deserves its own doc under `mobile/docs/` or `backend/docs/`. Create the doc, add a one-line pointer in CLAUDE.md (and in the "When to read which doc" table at the top), and put the detail there. The reason: CLAUDE.md is loaded into every session — every line costs context on every turn. Reference docs are loaded on demand only.

---

## Project Overview

**Golf Stuff In Here** — mobile-first golf league and tournament management app.
- **Backend:** Go + Fiber v2 API server with WebSockets, deployed on Railway (Docker-based)
- **Mobile:** React Native + Expo **SDK 54** (TypeScript), distributed via App Store / Google Play
- **Database:** PostgreSQL 16 with golang-migrate SQL migrations
- **Auth:** Supabase Auth (Google OAuth + Email OTP; sign-in and sign-up share one screen — Supabase handles both via `signInWithOtp`)
- **Module path:** `github.com/trentd187/golf-league`

> **SDK 54 pinned** — Expo Go on the Play Store is SDK 54. Do not upgrade to SDK 55 without verifying Expo Go compatibility.

> **Multi-profile Android installs** — `app.config.js` (dynamic config) replaces `app.json`. Each EAS profile sets `APP_VARIANT` in its `env` block; `app.config.js` uses it for unique Android package names so all three coexist on one device:
> - `development` → `com.trentd.golfstuffinhere.dev` / "Golf Stuff (Dev)"
> - `preview` → `com.trentd.golfstuffinhere.preview` / "Golf Stuff (Preview)"
> - `production` → `com.trentd.golfstuffinhere` / "Golf Stuff In Here"

---

## Universal Rules

### Cross-Platform (iOS + Android)

Every change must work on both. Primary testing is Android (Google Pixel). Never use an iOS-only API without an Android equivalent, and never leave Android with `undefined` where a behavior is needed. **Full keyboard/platform patterns: [`mobile/docs/keyboard-and-platform.md`](mobile/docs/keyboard-and-platform.md).**

### Comments

Every file must have a file-level comment explaining its purpose. Beyond that, comment to explain *why*, not *what*.

- File-level comment at the top of every file (required)
- Explain non-obvious decisions and non-obvious language/library features (e.g. `_` in Go, `??` in TypeScript, GORM struct tags, goroutines)
- Skip comments that restate the code

### Tests required in the same change

Every new handler, utility, screen, or component ships with tests in the **same commit**. Bug fixes also ship with a test that covers the fixed path. The coverage ratchet (`.go-coverage-baseline`, `.mobile-coverage-baseline`) blocks regressions at commit time. Do not use `LEFTHOOK=0` to defer tests. See [Pre-commit Hooks](#pre-commit-hooks-lefthook) below.

### Do not commit

Committing is the user's responsibility. Complete the change, verify it works, then stop. Do not stage, commit, or offer to commit.

---

## Environment / Shell

- Shell: **Git Bash** on Windows 11
- Node.js is installed but **not on the Git Bash PATH**. Prefix Node commands with:
  ```bash
  export PATH="/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm:$PATH"
  ```
- Go is available without a PATH workaround
- Working directory: `/c/Users/trent/git-repos/golf-league`

---

## Backend (Go)

### Package Structure

```
backend/
├── cmd/server/main.go         # Entry point only — no business logic
├── internal/config/           # Config struct loaded from env vars
├── internal/database/         # DB connection + migration runner
├── internal/handlers/         # HTTP handlers, one file per domain (events.go, users.go, …)
├── internal/middleware/       # auth.go (JWT) and roles.go (RBAC)
├── internal/models/           # All GORM models in models.go
├── internal/services/         # Business logic (to be added — keep handlers thin)
├── internal/websocket/        # WebSocket hub
└── migrations/                # SQL migration files
```

### Adding a New Handler

1. Create the handler in `internal/handlers/<domain>.go`
2. Register the route in `cmd/server/main.go`
3. Apply middleware: `middleware.Auth(cfg)` then `middleware.RequireRole(...)` as needed
4. **Write the `_test.go` in the same commit.** See [`backend/docs/testing.md`](backend/docs/testing.md).

Handler signature:
```go
func HandlerName(c *fiber.Ctx) error {
    // read from c.Params(), c.Body(), c.Locals()
    // return c.JSON(...) or c.Status(...).JSON(...)
}
```

### Adding a New Model

Add the struct to `internal/models/models.go`. Then create a migration — **never use GORM AutoMigrate** in production code.

### Migration Conventions

- Files in `backend/migrations/`
- Naming: `000002_description.up.sql` / `000002_description.down.sql`
- Increment the sequence number from the last migration
- Never edit an applied migration — create a new one
- The down migration must exactly reverse the up migration

### Role Enforcement

Apply middleware in this order:
```go
app.Use(middleware.Auth(cfg))                                                       // RS256/JWKS
app.Post("/events", middleware.RequireRole("admin", "manager"), handlers.CreateEvent)
```

The three global roles: `admin`, `manager`, `user`. **Per-event manager check** uses `isEventOrganizer()` in `handlers/events.go`; **per-round** uses `isRoundOrganizer()` in `handlers/rounds.go` (returns `(bool, uuid.UUID)` — check for `uuid.Nil`).

### Score Entry Permission Check

Score mutation endpoints must check the requesting user is a member of the same playing group as the target `round_player`. More granular than role-checking — done in the handler or a dedicated `RequireGroupMember()` middleware (stub in `middleware/roles.go`).

### Environment Variables

Read in `internal/config/config.go`. Add new vars by: (1) field on `Config` struct, (2) `os.Getenv("VAR_NAME")` in `Load()`, (3) entry in `backend/.env.example`.

Required:
- `DATABASE_URL` — PostgreSQL connection string
- `SUPABASE_JWKS_URL` — Format: `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json` (project ref from Supabase Dashboard → Project Settings → Data API → Project URL)
- `PORT` — HTTP port (default `8080`)
- `ENV` — runtime environment (default `development`)
- `GOLF_COURSE_API_KEY` — Free key from [golfcourseapi.com](https://golfcourseapi.com). Enables `POST /courses/search-external`, `POST /courses/import-external`, `POST /courses/:courseId/refresh`. Empty disables external import (manual entry still works).

---

## Mobile (React Native + Expo)

### Package Manager

**Always `pnpm`** in `mobile/`. Never `npm install`.

```bash
pnpm install
pnpm add some-package
npx expo install expo-camera   # for packages with native modules — picks SDK-compatible version
```

### Adding a New Screen

Create a `.tsx` file in `app/` — file path determines the route:

```
app/events/[id].tsx        →  /events/:id  (stack screen, no tab bar)
app/(tabs)/events.tsx      →  /events      (tab screen)
```

Every new screen needs: file-level comment, default-export React component, NativeWind `className` for styling.

### Styling — NativeWind only

Always use NativeWind `className`. Never `StyleSheet.create()` or inline `style={{}}` (exception: dynamic theme hex on `<Text>` — see themes doc).

```tsx
<View className="flex-1 items-center justify-center bg-white p-4">
```

Primary brand: **green-700** (`#15803d`). Secondary: gray. Errors: red-600.

**Theme tokens are required for all surfaces, text, and borders.** See [`mobile/docs/themes.md`](mobile/docs/themes.md) for the slot table and JIT constraint.

### API Calls — TanStack Query

```tsx
import { useQuery, useMutation } from "@tanstack/react-query";
import { API_URL } from "@/constants/api";

const { data } = useQuery({
  queryKey: ["events"],
  queryFn: () => fetch(`${API_URL}/api/v1/events`).then(r => r.json()),
});
```

### State Management

- **Server state:** TanStack Query
- **Client/UI state:** Zustand stores in `stores/`
- **Theme state:** `stores/themeStore.ts` — persisted to SecureStore; access via `useTheme()` hook
- **Auth state:** `hooks/useAuth.ts` (getToken, signOut) and `hooks/useUser.ts` (Supabase User + loading)

### Path Aliases

`@/` resolves to `mobile/` root. Use it for all internal imports — no relative paths.

```tsx
import { tokenCache } from "@/utils/cache";   // correct
```

### Reusable components

See [`mobile/docs/components.md`](mobile/docs/components.md) for the component catalog and the "always use a shared component" patterns table.

---

## Mobile Code Quality Rules

### Use `globalThis` not `global` in test files

`global` is Node-specific; `tsc` (with Expo's lib config) errors *Cannot find name 'global'*. Use `globalThis` with a cast:

```ts
(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({ ... });
```

### Only destructure what you use

Unused destructured variables cause warnings and mislead readers.

### No copy-pasted JSX blocks

Same JSX twice → extract. Either a component (if reusable) or a loop/helper inline. If a sub-component might be used by another screen, put it in `components/` from day one.

### Cards that lead somewhere must be `TouchableOpacity`

Even if the destination doesn't exist yet — Expo Router's "Unmatched Route" page in dev is harmless.

```tsx
<TouchableOpacity onPress={() => router.push(`/rounds/${round.id}`)} activeOpacity={0.7}>
```

### Extract-first rule (coverage protection)

**Any non-trivial logic added to a screen component MUST be extracted to `utils/` first as a pure function with its own test.** Then the component calls the utility. This is the only way coverage stays stable when screen files (which are excluded from coverage) get modified. Example: auto-fill calculations in `utils/scorecard.ts` rather than inline in `[roundId].tsx`.

---

## Data Model

Full model in [`DATA_MODEL.md`](DATA_MODEL.md), `backend/internal/models/models.go`, and `backend/migrations/000001_initial_schema.up.sql`.

There is **no separate `leagues` table.** An `event` with `event_type = 'league'` IS the league. Hierarchy:

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

**Tee gender** — `tees.gender` (`mens`/`womens`/`unisex`) is NOT exposed in mobile UI. Tee names (Blue, White, Red) are the identifier. The backend `CreateTee` defaults `gender` to `"unisex"` when omitted. External imports retain GolfCourseAPI's male/female split. Do not add a gender picker.

**Per-event manager check** — two-tier:
- `admin` global → can manage any event
- `manager` or `user` global → only events where `event_players.role = 'organizer'` for that event

The creator is auto-added as organizer in the `POST /api/v1/events` transaction. Use `isEventOrganizer()` in every handler that modifies an event.

**Round detail response** includes `is_organizer: bool` computed server-side. The mobile `rounds/[id].tsx` uses this directly — no separate query.

**Organizer event actions** — cancel (`PATCH /events/:id` with `{status:"cancelled"}`) or delete (`DELETE /events/:id`). Both go through `isEventOrganizer`. Deletion cascades via DB constraints.

### Handicap Rule

Player-entered per round — **no automatic WHS calculation.**

- Stored in `round_players.course_handicap` (int) — playing handicap for that round
- `round_players.handicap_index` (decimal) is optional and unused in any calculation
- `rounds.requires_handicap = true` → score entry is blocked until `course_handicap` is set
- Enforced at the API layer on score mutation routes
- Do **not** implement the WHS formula (`handicap_index × slope / 113 + rating - par`) — replaced

### Finish Position

`round_players.finish_position` (within a round) and `event_players.finish_position` (across the event). Both `nullable INT`, set programmatically when status flips to `completed`.

---

## Backend Testing

Full strategy, tier patterns, coverage commands, and what to test: [`backend/docs/testing.md`](backend/docs/testing.md).

**Required for every new handler:** a `_test.go` covering all Tier 1 paths (validation, bad UUIDs, missing fields) in the same commit.

**Run before declaring done:**
```bash
go test -count=1 -coverpkg=github.com/trentd187/golf-league/internal/handlers,github.com/trentd187/golf-league/internal/middleware -coverprofile=coverage.out ./... && go tool cover -func=coverage.out | grep "^total:"
```
`-count=1` is required — without it the test cache replays a stale coverage profile.

---

## Docker / Railway Deployment

- `docker-compose.yml` at repo root is local-dev only
- Backend waits for DB healthcheck before starting (`depends_on: condition: service_healthy`)
- Migrations run automatically on every server startup via `database.RunMigrations()`
- Dockerfile is multi-stage: `golang:1.24-alpine` build, `alpine:3.21` run

**Production: Railway.** Builds and deploys the `Dockerfile` in `backend/` on push to `main`. PostgreSQL is a Railway managed service. Env vars configured in Railway project settings.

---

## Pre-commit Hooks (lefthook)

Hooks managed by **lefthook** (`lefthook.yml`). Installed automatically when running `pnpm install` in `mobile/` (the `postinstall` runs `lefthook install`).

| Hook | Trigger | Action |
|---|---|---|
| `backend-lint` | `backend/**/*.go` staged | golangci-lint; blocks on errors |
| `backend-coverage` | `backend/**/*.go` staged | `go test ./...` with coverage (Tier 1 + Tier 2); blocks if below `.go-coverage-baseline`. **Requires Docker running** — Tier 2 uses testcontainers-go to spin up an ephemeral Postgres |
| `backend-docker-build` | `backend/**` or `Dockerfile` changed vs origin/main | Builds Railway Dockerfile; skipped if Docker not running |
| `mobile-typecheck` | `mobile/**/*.{ts,tsx}` staged | `tsc --noEmit` |
| `mobile-lint` | `mobile/**/*.{ts,tsx,js}` staged | ESLint via `expo lint` |
| `mobile-expo-doctor` | `mobile/**/*.{ts,tsx,js,json}` staged | `expo-doctor` (17 checks) |
| `mobile-coverage` | `mobile/**/*.{ts,tsx}` staged | Jest with coverage; blocks if below `.mobile-coverage-baseline` |

No `pre-push` hook — all checks run at commit.

**Coverage ratchet** — baselines (`.go-coverage-baseline`, `.mobile-coverage-baseline`) auto-update upward, never decrease. Mobile measured: `utils/**/*.ts`, `app/sign-in.tsx`, `app/index.tsx`, `app/(tabs)/profile.tsx`, `app/users/**/*.tsx`. Large screen files (scorecard, events, rounds, courses) are excluded — they belong to a future E2E suite. **This is why the extract-first rule matters: logic added inline to those files is invisible to coverage, but new utility functions count.**

**Bypass** — `LEFTHOOK=0 git commit` is only for pure layout/styling/wiring changes where all logic is already in `utils/` with tests. Never to defer tests.

**One-time setup:**
```bash
cd mobile && pnpm install                                                  # installs hooks
go install github.com/golangci/golangci-lint/cmd/golangci-lint@v1.64.8     # global
```

---

## Linting

### Backend — golangci-lint

Config: `backend/.golangci.yml`. Linters: `errcheck`, `govet`, `staticcheck`, `ineffassign`, `gosimple`, `unused`, `misspell`, `gosec`, `gofmt`, `goimports`.

```bash
golangci-lint run ./...
golangci-lint run --fix ./...        # auto-fix formatting
cd backend && gofmt -w . && goimports -w .   # if hook fails on formatting
```

### Mobile — ESLint

Config: `mobile/eslint.config.js` (ESLint 9 flat config). Uses `eslint-config-expo` + `eslint-plugin-react-native`.

Notable:
- `react-native/no-inline-styles`: **warn** — inline styles are intentional only for dynamic theme hex; suppress with `// eslint-disable-next-line react-native/no-inline-styles`
- `import/no-unresolved`: **off** — pnpm's layout confuses the resolver; `tsc` catches real missing imports

```bash
pnpm lint
pnpm lint --fix
```

---

## SonarCloud

Config: `sonar-project.properties`. Quality chain: pre-commit (local) → SonarCloud Scanner CI (workflow TBD) → SonarLint VS Code extension in connected mode.

To complete CI setup: fill `sonar.projectKey`/`sonar.organization`, add `SONAR_TOKEN` GitHub secret, add a workflow that runs SonarScanner on push to `main` and PRs.

---

## Git Conventions

- Branch from `main` for new features
- Commit messages: concise, "why" over "what"
- Never commit `.env` files (in `.gitignore`)
