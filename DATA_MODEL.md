# Golf League App — Data Model Reference

This document describes the full database schema for the Golf Stuff In Here app.
It is the authoritative reference for understanding how data is structured and related.

---

## Overview: The Hierarchy

```
users

events  (type: "league" | "tournament" | "casual")
  ├── event_players  (who belongs to / participates in this event)
  │       role: "organizer" | "player"
  │       status: "invited" | "registered" | "withdrawn" | "completed"
  │
  ├── event_points_rules  (how many points each finish position earns)
  │
  └── rounds  (one or many rounds of golf within the event)
        │
        ├── round_players  (per-round data for each participant)
        │       └── scores  (one row per player per hole, 18 rows for a full round)
        │
        ├── groups  (tee-time groupings)
        │       └── group_players  (which round_players are in which group)
        │
        └── teams  (for scramble / best-ball formats)
                ├── team_members  (which round_players are on which team)
                └── team_scores  (team's combined score per hole)

courses
  └── tees  (tee sets: Blue, White, Red, etc.)
        └── holes  (per-hole par, stroke index, yardage)
```

---

## Why events, not leagues?

The app uses a single `events` table as the top-level container for all competitions.
An event's `event_type` field controls what kind of competition it is:

| type | meaning |
|---|---|
| `league` | An ongoing, multi-round season where standings accumulate over time |
| `tournament` | A one-off competitive event (1 or more rounds) |
| `casual` | Informal round with friends — no standings, no points |

This avoids the need for a separate `leagues` table and keeps the hierarchy clean:
**event → rounds → scores**, regardless of whether it's a league season or a tournament.

---

## Tables

### `users`
Everyone who has signed in through Clerk. Created automatically on first API request.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | auto-generated |
| `clerk_id` | VARCHAR unique | Clerk's user ID (e.g. `user_2abc123`) |
| `display_name` | VARCHAR | From Clerk JWT `name` claim |
| `email` | VARCHAR unique | From Clerk JWT `email` claim |
| `avatar_url` | VARCHAR nullable | Profile picture URL |
| `role` | user_role | Global role: `admin`, `manager`, or `user` |
| `created_at` / `updated_at` | TIMESTAMPTZ | Auto-managed |

---

### `events`
The top-level container for any golf competition. Can be a league season, tournament, or casual round.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | VARCHAR | e.g. "2025 Saturday Morning League" |
| `description` | TEXT nullable | Optional longer description |
| `event_type` | event_type | `league`, `tournament`, or `casual` |
| `status` | event_status | `upcoming`, `active`, `completed`, `cancelled` |
| `start_date` | DATE nullable | Optional season/event start |
| `end_date` | DATE nullable | Optional season/event end |
| `created_by` | UUID FK → users | Who created this event |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

---

### `event_players`
Links users to events. Serves as both "league membership" (for league-type events)
and "tournament registration" (for tournament-type events).

The `role` field controls management rights within the event:
- `organizer` — can edit the event, invite members, and schedule rounds
- `player` — participant only

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `event_id` | UUID FK → events | |
| `user_id` | UUID FK → users | |
| `role` | event_player_role | `organizer` or `player` |
| `status` | event_player_status | `invited`, `registered`, `withdrawn`, `completed` |
| `finish_position` | INT nullable | Set when event is finalized |
| `total_gross_score` | INT nullable | Sum of gross scores across all rounds |
| `total_net_score` | INT nullable | Sum of net scores (handicap-adjusted) |
| `total_points` | INT nullable | League points earned |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

UNIQUE constraint on `(event_id, user_id)` — a user can only be in an event once.

---

### `event_points_rules`
Defines the points table for an event. E.g. 1st = 100 pts, 2nd = 80 pts.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `event_id` | UUID FK → events | ON DELETE CASCADE |
| `finish_position` | INT | 1 = first place |
| `points` | INT | Points awarded |

UNIQUE on `(event_id, finish_position)`.

---

### `rounds`
A single session of golf within an event. A league season or multi-day tournament
has multiple rounds; a casual round has just one.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `event_id` | UUID FK → events | ON DELETE CASCADE |
| `course_id` | UUID FK → courses | |
| `default_tee_id` | UUID FK → tees | Most players use this tee; individuals can override |
| `round_number` | INT | 1 for first round, 2 for second, etc. |
| `scheduled_date` | DATE | |
| `status` | round_status | `scheduled`, `active`, `completed` |
| `scoring_format` | scoring_format | See formats below |
| `requires_handicap` | BOOLEAN | If true, handicap must be set before score entry |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

---

### `round_players`
Per-round data for each participant. Links an `event_player` to a specific `round`.
A player must be an `event_player` before they can be a `round_player`.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `round_id` | UUID FK → rounds | ON DELETE CASCADE |
| `event_player_id` | UUID FK → event_players | ON DELETE CASCADE |
| `tee_id` | UUID FK → tees (nullable) | Override for players who use a different tee |
| `handicap_index` | DECIMAL(4,1) nullable | Player's WHS handicap index at time of round |
| `course_handicap` | INT nullable | Calculated playing handicap for this course + tee |
| `finish_position` | INT nullable | Player's rank in this round |
| `points_earned` | INT nullable | Points from this round (if applicable) |
| `status` | round_player_status | `registered`, `active`, `withdrawn`, `completed` |

UNIQUE on `(round_id, event_player_id)`.

---

### `scores`
One row per player per hole. A complete 18-hole round = 18 rows per `round_player`.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `round_player_id` | UUID FK → round_players | ON DELETE CASCADE |
| `hole_number` | INT | 1–18 |
| `gross_score` | INT | Actual strokes taken |
| `net_score` | INT | Gross minus handicap strokes for this hole |
| `entered_by` | UUID FK → users | Who entered the score (player, group member, or scorer) |
| `entered_at` / `updated_at` | TIMESTAMPTZ | |

UNIQUE on `(round_player_id, hole_number)`.

---

### `groups`
Tee-time groupings within a round. Players in the same group tee off together.
`starting_hole` supports shotgun starts where groups begin on different holes simultaneously.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `round_id` | UUID FK → rounds | ON DELETE CASCADE |
| `group_number` | INT | Display order (group 1 tees first) |
| `tee_time` | TIMESTAMPTZ nullable | Scheduled start time |
| `starting_hole` | INT | Default 1; other values for shotgun starts |

---

### `group_players`
Join table placing a `round_player` into a `group`. Composite PK prevents a player
from being in two groups in the same round.

| column | type | notes |
|---|---|---|
| `group_id` | UUID FK → groups PK | ON DELETE CASCADE |
| `round_player_id` | UUID FK → round_players PK | ON DELETE CASCADE |

---

### `teams`
Named teams for team-format rounds (scramble, best ball, etc.).
Teams belong to a round — compositions can change between rounds.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `round_id` | UUID FK → rounds | ON DELETE CASCADE |
| `name` | VARCHAR | e.g. "Team A", "The Hackers" |
| `finish_position` | INT nullable | Set when round is finalized |

---

### `team_members`
Join table placing a `round_player` on a `team`. Composite PK prevents a player
from being on two teams in the same round.

---

### `team_scores`
The team's combined score per hole in team-format rounds (e.g., scramble: one score per hole for the whole team).

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `team_id` | UUID FK → teams | ON DELETE CASCADE |
| `hole_number` | INT | 1–18 |
| `gross_score` / `net_score` | INT | |
| `entered_by` | UUID FK → users | |

UNIQUE on `(team_id, hole_number)`.

---

### `courses`
Golf courses where rounds are played. Shared across all events — courses are a reference catalog.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `name` | VARCHAR | e.g. "Augusta National" |
| `city` | VARCHAR | Default '' — optional for auto-created courses |
| `state` | VARCHAR | Default '' — optional for auto-created courses |
| `hole_count` | INT | Default 18 |

---

### `tees`
One set of tee boxes on a course (e.g., Blue, White, Red). Each tee set has its own
course rating and slope, which are used to calculate handicaps.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `course_id` | UUID FK → courses | ON DELETE CASCADE |
| `name` | VARCHAR | e.g. "Blue", "White", "Default" |
| `gender` | tee_gender | `mens`, `womens`, `unisex` |
| `course_rating` | DECIMAL(4,1) | USGA rating — expected score for a scratch golfer (e.g., 72.4) |
| `slope_rating` | INT | USGA slope — difficulty for bogey golfer vs scratch (55–155) |
| `par` | INT | Total par for all holes from this tee |

---

### `holes`
Per-hole details for each tee set. Par and stroke index can differ between tee sets on the same course.

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `tee_id` | UUID FK → tees | ON DELETE CASCADE |
| `hole_number` | INT | 1–18 |
| `par` | INT | Expected strokes (3, 4, or 5) |
| `stroke_index` | INT | Handicap allocation: 1 = hardest (first stroke), 18 = easiest |
| `yardage` | INT nullable | Distance in yards |

---

## Enums

| enum | values |
|---|---|
| `user_role` | `admin`, `manager`, `user` |
| `event_type` | `league`, `tournament`, `casual` |
| `event_status` | `upcoming`, `active`, `completed`, `cancelled` |
| `event_player_role` | `organizer`, `player` |
| `event_player_status` | `invited`, `registered`, `withdrawn`, `completed` |
| `round_status` | `scheduled`, `active`, `completed` |
| `round_player_status` | `registered`, `active`, `withdrawn`, `completed` |
| `scoring_format` | `stroke`, `net_stroke`, `stableford`, `skins`, `match_play`, `scramble`, `best_ball` |
| `tee_gender` | `mens`, `womens`, `unisex` |

---

## Permission Model

Two layers of access control govern the app:

### 1. Route-level (global `user_role`)
Checked by `middleware.RequireRole()` before the handler runs.

| action | required global role |
|---|---|
| Create an event | `admin` or `manager` |
| View events, read data | any authenticated user |

### 2. Resource-level (event `event_player_role`)
Checked inside handlers via `isEventOrganizer()` in `handlers/events.go`.
Controls who can modify a **specific** event.

| global role | can manage this event? |
|---|---|
| `admin` | yes, any event |
| `manager` | only if `event_players.role = 'organizer'` for this event |
| `user` | only if `event_players.role = 'organizer'` for this event |

A manager who creates an event is auto-added as its organizer and can manage it.
A manager **cannot** manage an event they didn't create unless another organizer explicitly grants them the organizer role in that event's `event_players` row.

---

## Key Design Decisions

**Why is `event_player` the bridge between events and rounds?**
A `round_player` links to an `event_player`, not directly to a `user`. This ensures only
people who are registered for an event can play rounds within it. It also lets us track
cumulative statistics (total gross score, finish position, points) at the event level.

**Why are `handicap_index` and `course_handicap` on `round_players`, not `event_players`?**
A player's handicap can change between rounds (the WHS recalculates it frequently), so we
snapshot it at the time of each round for historical accuracy.

**Why are `city` and `state` on courses optional (empty string default)?**
When a user schedules a round from within the app by typing a course name, we auto-create
the course record. We don't want to require the organizer to provide full course details
upfront — those can be filled in later.

**What is the `entered_by` field on scores for?**
In a group of four players, any player in the group can enter scores for others (common in
real golf). `entered_by` tracks who submitted each score for accountability.
