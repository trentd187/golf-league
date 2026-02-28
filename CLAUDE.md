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
- **Mobile:** React Native + Expo (TypeScript), distributed via App Store / Google Play
- **Database:** PostgreSQL 16 with golang-migrate SQL migrations
- **Auth:** Clerk (Google OAuth + Email OTP)
- **Module path:** `github.com/trentd187/golf-league`

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
├── internal/handlers/         # HTTP handlers, one file per domain (e.g., leagues.go, rounds.go)
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
app.Post("/leagues", middleware.RequireRole("admin", "manager"), handlers.CreateLeague)
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
app/leagues/index.tsx      →  /leagues
app/leagues/[id].tsx       →  /leagues/:id
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

### API Calls

Use TanStack Query (`useQuery` / `useMutation`) and the `API_URL` from `constants/api.ts`:

```tsx
import { useQuery, useMutation } from "@tanstack/react-query";
import { API_URL } from "@/constants/api";

// Fetching data
const { data } = useQuery({
  queryKey: ["leagues"],
  queryFn: () => fetch(`${API_URL}/api/v1/leagues`).then(r => r.json()),
});

// Mutating data
const mutation = useMutation({
  mutationFn: (newLeague) =>
    fetch(`${API_URL}/api/v1/leagues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newLeague),
    }).then(r => r.json()),
});
```

### State Management

- **Server state** (API data): TanStack Query
- **Client/UI state** (modals open, form inputs, etc.): Zustand stores in `stores/`
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

### TypeScript Path Aliases

The `@/` alias resolves to the `mobile/` root. Use it for all internal imports:
```tsx
import { tokenCache } from "@/utils/cache";   // correct
import { tokenCache } from "../../utils/cache"; // avoid relative paths
```

---

## Data Model

The full data model is in `backend/internal/models/models.go` and `backend/migrations/000001_initial_schema.up.sql`.

Key hierarchy:
```
users
leagues → league_members → users
events → event_players → users
       → event_points_rules
       → rounds → round_players → scores
                → groups → group_players → round_players
                → teams → team_members → round_players
                        → team_scores
courses → tees → holes
```

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
