# Golf Stuff In Here — Backend

The Go REST API and WebSocket server for the Golf Stuff In Here app.

## Tech Stack

| Tool | Purpose |
|---|---|
| [Go 1.24](https://go.dev) | Programming language |
| [Fiber v2](https://gofiber.io) | HTTP web framework (Express-like) |
| [GORM](https://gorm.io) | ORM for database access |
| [golang-migrate](https://github.com/golang-migrate/migrate) | SQL migration runner |
| [gofiber/websocket](https://github.com/gofiber/websocket) | WebSocket support for live scores |
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
│   ├── models/
│   │   └── models.go        # GORM struct definitions for every database table
│   └── websocket/
│       └── hub.go           # WebSocket hub — broadcasts live score updates to connected clients
├── migrations/
│   ├── 000001_initial_schema.up.sql    # Creates all tables, enums, and indexes
│   └── 000001_initial_schema.down.sql  # Drops everything (used to roll back)
├── .env.example             # Environment variable template — copy to .env and fill in
├── Dockerfile               # Multi-stage Docker build
└── go.mod / go.sum          # Go module definition and dependency checksums
```

## Setup

### Prerequisites

- Go 1.24 or newer
- Docker Desktop (for running PostgreSQL locally)
- A [Clerk](https://clerk.com) account

### Environment Variables

Copy the example file and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description | Example |
|---|---|---|
| `PORT` | Port the server listens on | `8080` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://postgres:password@localhost:5432/golf_league?sslmode=disable` |
| `CLERK_SECRET_KEY` | Secret key from Clerk Dashboard → API Keys | `sk_test_...` |
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

### Real-time WebSockets

The WebSocket hub in `internal/websocket/hub.go` broadcasts score updates to all clients watching a specific round. When a score is submitted via the REST API, the handler calls `hub.BroadcastToRound(roundID, data)` and all connected mobile clients receive the update instantly.

## Docker

The `Dockerfile` uses a two-stage build:

1. **Build stage** (`golang:1.24-alpine`) — compiles the Go binary
2. **Runtime stage** (`alpine:latest`) — contains only the binary and migrations folder (~10MB total)

```bash
# Build the image
docker build -t golf-league-backend .

# Run it
docker run -p 8080:8080 --env-file .env golf-league-backend
```
