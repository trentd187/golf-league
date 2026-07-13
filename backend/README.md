# Golf Stuff In Here — Backend

The Go REST API for the Golf Stuff In Here app.

## Tech Stack

| Tool | Purpose |
|---|---|
| [Go 1.26](https://go.dev) | Programming language |
| [Fiber v2](https://gofiber.io) | HTTP web framework (Express-like) |
| [GORM](https://gorm.io) | ORM for database access |
| [golang-migrate](https://github.com/golang-migrate/migrate) | SQL migration runner |
| [golang-jwt/jwt](https://github.com/golang-jwt/jwt) | Clerk JWT token validation |
| [godotenv](https://github.com/joho/godotenv) | Load `.env` files in development |
| PostgreSQL 16 | Database |

## Directory Structure

```
backend/
├── cmd/
│   └── server/
│       └── main.go          # Entry point — wires everything together and starts the server
├── internal/
│   ├── config/
│   │   └── config.go        # Reads environment variables into a typed Config struct
│   ├── database/
│   │   └── database.go      # Database connection and migration runner
│   ├── handlers/
│   │   └── health.go        # HTTP route handlers (one file per domain as the API grows)
│   ├── middleware/
│   │   ├── auth.go          # Clerk JWT validation — extracts userID and role from token
│   │   └── roles.go         # Role-based access control — RequireRole() middleware
│   └── models/
│       └── models.go        # GORM struct definitions for every database table
├── migrations/
│   ├── 000001_initial_schema.up.sql    # Creates all tables, enums, and indexes
│   └── 000001_initial_schema.down.sql  # Drops everything (used to roll back)
├── .env.example             # Environment variable template — copy to .env and fill in
├── Dockerfile               # Multi-stage Docker build
└── go.mod / go.sum          # Go module definition and dependency checksums
```

## Setup

### Prerequisites

- Go 1.26 or newer
- Docker Desktop (for running PostgreSQL locally)
- A [Clerk](https://clerk.com) account

### Environment Variables

Copy the example file and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description | Where to find it |
|---|---|---|
| `PORT` | Port the server listens on (default: `8080`) | — |
| `DATABASE_URL` | PostgreSQL connection string | Railway dashboard → database service |
| `CLERK_SECRET_KEY` | Clerk Backend API key | Clerk Dashboard → API Keys |
| `CLERK_JWKS_URL` | Clerk's public key endpoint for JWT verification | Clerk Dashboard → API Keys → Advanced |
| `ENV` | Runtime environment | `development` or `production` |

### Running Locally

**Option 1 — Docker Compose (recommended):**

From the repository root:

```bash
docker compose up
```

This starts both PostgreSQL and the backend together. Migrations run automatically on startup.

**Option 2 — Run Go directly (requires a running PostgreSQL):**

```bash
cd backend
go run ./cmd/server
```

### Verify It's Working

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

## Database Migrations

Migrations live in `migrations/` and are run automatically every time the server starts. golang-migrate tracks which migrations have already been applied and only runs new ones.

**File naming convention:**
```
000001_initial_schema.up.sql    # Applied when migrating up (forward)
000001_initial_schema.down.sql  # Applied when rolling back (reverse)
```

When adding new migrations, increment the number:
```
000002_add_something.up.sql
000002_add_something.down.sql
```

Never edit a migration file that has already been applied in any environment. Create a new migration instead.

## API Structure

Routes are registered in `cmd/server/main.go`. As the API grows, handlers are organized by domain:

```
GET  /health                  # Liveness check — no auth required

# Future routes follow this pattern:
# GET    /api/v1/leagues               RequireRole(admin, manager, user)
# POST   /api/v1/leagues               RequireRole(admin, manager)
# DELETE /api/v1/leagues/:id           RequireRole(admin, manager)
```

### Authentication

All protected routes use the `Auth` middleware from `internal/middleware/auth.go`. It:
1. Reads the `Authorization: Bearer <token>` header
2. Validates the Clerk JWT
3. Stores `userID` and `userRole` in `fiber.Ctx.Locals` for downstream handlers

Role enforcement is then applied per-route with `RequireRole("admin", "manager")`.

### Live score updates

The server **pushes nothing** — clients poll `GET /rounds/:roundId/scorecard` every 60s while the
screen is focused. A live-score WebSocket used to exist and was removed: it echoed every save back
to the device that made it (whose refetch reflowed the scorecard mid-tap and swallowed FIR/GIR
presses), and it never completed a `wss` handshake on the league's cellular network. Full rationale:
[`mobile/docs/live-updates.md`](../mobile/docs/live-updates.md).

`GET /api/v1/ws/rounds/:roundId` survives as a tombstone returning **410 Gone**
(`internal/handlers/sunset.go`) so builds already on players' phones stop retrying and fall back to
their poll. Delete it once the sampled `ws.sunset_hit` log goes quiet.

## Docker / Railway Deployment

The `Dockerfile` uses a two-stage build:

1. **Build stage** (`golang:1.26-alpine`) — compiles the Go binary
2. **Runtime stage** (`alpine:latest`) — contains only the binary and migrations folder (~10MB total)

**Local testing of the Docker image:**
```bash
docker build -t golf-league-backend .
docker run -p 8080:8080 --env-file .env golf-league-backend
```

**Production (Railway):**
Railway detects the `Dockerfile` automatically and builds + deploys it on every push to `main`. Environment variables are set in the Railway project dashboard — no manual Docker commands needed for deployment.
