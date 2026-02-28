# Golf Stuff In Here

A mobile-first golf league and tournament management application. Players can track scores in real time, manage handicaps, run events and leagues, and view live leaderboards.

## Features

- **Leagues** — organize players into groups that compete across multiple events
- **Events** — seasons, tournaments, and casual rounds with multi-round support
- **Scoring** — live hole-by-hole score entry with real-time leaderboard updates
- **Handicaps** — manually entered handicap indexes per round with automatic course handicap calculation
- **Team formats** — scramble, best ball, skins, match play, and more
- **Authentication** — Google OAuth and email one-time passcode (OTP) via Clerk

## Tech Stack

| Layer | Technology |
|---|---|
| Mobile app | React Native + Expo SDK 55 (TypeScript) |
| Backend API | Go + Fiber v2 |
| Database | PostgreSQL 16 |
| ORM | GORM |
| Migrations | golang-migrate |
| Real-time | WebSockets (gofiber/websocket) |
| Auth | Clerk |
| Deployment | AWS ECS (backend) + App Store / Google Play (mobile) |

## Repository Structure

```
golf-league/
├── backend/            # Go REST API + WebSocket server
├── mobile/             # React Native + Expo mobile app
├── docker-compose.yml  # Local development environment (postgres + backend)
├── .env.example        # Root environment variable template
└── CLAUDE.md           # AI assistant instructions for this project
```

See [backend/README.md](backend/README.md) and [mobile/README.md](mobile/README.md) for setup details.

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Go 1.24+](https://go.dev/dl/)
- [Node.js 20+](https://nodejs.org/) and [pnpm](https://pnpm.io/)
- A [Clerk](https://clerk.com) account (free tier is sufficient)

### 1. Clone and configure environment

```bash
git clone https://github.com/trentd187/golf-league.git
cd golf-league

# Copy and fill in environment files
cp .env.example .env
cp backend/.env.example backend/.env
cp mobile/.env.example mobile/.env
```

Open each `.env` file and fill in the required values:

| File | Key | Where to find it |
|---|---|---|
| `.env` | `DB_PASSWORD` | Choose any password for local postgres |
| `backend/.env` | `CLERK_SECRET_KEY` | Clerk Dashboard → API Keys |
| `mobile/.env` | `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk Dashboard → API Keys |

### 2. Start the backend

```bash
docker compose up
```

This starts PostgreSQL and the Go API server. On first run, migrations automatically create all database tables. The API is available at `http://localhost:8080`.

Verify it's running:
```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

### 3. Start the mobile app

```bash
cd mobile
pnpm start
```

Then scan the QR code with the [Expo Go](https://expo.dev/go) app on your phone, or press `a` for Android emulator / `i` for iOS simulator.

## Roles & Permissions

The app has three permission levels:

| Role | Capabilities |
|---|---|
| `admin` | Full access to everything |
| `manager` | Create/manage leagues, courses, events, rounds, groups; update own scores |
| `user` | View invited leagues/events; join events; update own scores |

## Development

See the sub-project READMEs for detailed development guides:

- [Backend development guide](backend/README.md)
- [Mobile development guide](mobile/README.md)
