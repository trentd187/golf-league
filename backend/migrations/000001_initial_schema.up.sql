-- migrations/000001_initial_schema.up.sql
-- This is the "up" migration — it creates the initial database schema from scratch.
-- Migrations are versioned SQL scripts that the golang-migrate library applies in order.
-- The "up" file adds schema; the matching "down" file removes it (for rollbacks).
-- This file is only ever run ONCE per database; migrate tracks it in a schema_migrations table.

-- Enable UUID generation
-- pgcrypto is a PostgreSQL extension that provides cryptographic functions,
-- including gen_random_uuid() which we use to generate UUID primary keys.
-- "IF NOT EXISTS" means it's safe to run even if the extension is already installed.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enums
-- PostgreSQL supports custom ENUM types, which enforce that a column can only hold
-- one of a predefined set of string values. This is more efficient and safer than
-- plain VARCHAR because the database itself rejects invalid values.

CREATE TYPE user_role AS ENUM ('admin', 'manager', 'user');

-- event_type: what kind of competition is being run.
-- "league"      — an ongoing, multi-round season with accumulated standings.
-- "tournament"  — a one-off competitive event (1 or more rounds).
-- "casual"      — informal round with friends; no standings, no points.
--
-- Note: there is no separate "leagues" table. An event with type "league" IS the league.
-- This keeps the hierarchy simple: events contain rounds, regardless of competition type.
CREATE TYPE event_type AS ENUM ('league', 'tournament', 'casual');

-- event_status: lifecycle state of an event
CREATE TYPE event_status AS ENUM ('upcoming', 'active', 'completed', 'cancelled');

-- event_player_role: permission level within a specific event.
-- "organizer" — can edit the event, invite members, and schedule rounds.
-- "player"    — participant only; can view the event and enter scores.
--
-- This replaces the old league_member_role enum (which had 'admin'/'member').
CREATE TYPE event_player_role AS ENUM ('organizer', 'player');

-- event_player_status: tracks whether a player has confirmed, withdrawn, or finished an event
CREATE TYPE event_player_status AS ENUM ('invited', 'registered', 'withdrawn', 'completed');

-- round_status: lifecycle state of a single round within an event
CREATE TYPE round_status AS ENUM ('scheduled', 'active', 'completed');

-- scoring_format: determines how scores are tallied and a winner is determined
CREATE TYPE scoring_format AS ENUM ('stroke', 'net_stroke', 'stableford', 'skins', 'match_play', 'scramble', 'best_ball');

-- round_player_status: tracks a player's state within a single round
CREATE TYPE round_player_status AS ENUM ('registered', 'active', 'withdrawn', 'completed');

-- tee_gender: golf courses rate tees separately by gender due to different distances
CREATE TYPE tee_gender AS ENUM ('mens', 'womens', 'unisex');

-- Users
-- The users table stores everyone who has signed in through Clerk.
-- UUIDs are used as primary keys throughout — they're globally unique and safe
-- to generate on the client side, unlike sequential integers.
-- TIMESTAMPTZ stores timestamps with timezone info (UTC recommended for servers).
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- gen_random_uuid() generates a v4 UUID automatically
    display_name VARCHAR NOT NULL,
    email VARCHAR NOT NULL UNIQUE,     -- UNIQUE creates an index and rejects duplicate emails
    avatar_url VARCHAR,                -- Nullable: not all users have a profile picture
    role user_role NOT NULL DEFAULT 'user', -- Default to least-privileged role
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Courses
-- A golf course where rounds are played. Hole count is usually 18 but can be 9.
-- city and state default to '' so the app can auto-create a course from just its name
-- when an organizer schedules a round. These can be filled in properly later.
CREATE TABLE courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR NOT NULL,
    city VARCHAR NOT NULL DEFAULT '',   -- Defaults to empty string; fill in later if desired
    state VARCHAR NOT NULL DEFAULT '',  -- Defaults to empty string; fill in later if desired
    hole_count INT NOT NULL DEFAULT 18,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tees
-- Each course has multiple sets of tee boxes (e.g., "Blue", "White", "Red").
-- Each tee set has a different course rating and slope used for handicap calculations.
-- course_rating is stored as DECIMAL(4,1) to hold values like 72.4 (max 999.9).
-- ON DELETE CASCADE: deleting a course removes all its tee data.
CREATE TABLE tees (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    name VARCHAR NOT NULL,             -- e.g., "Blue", "White", "Default"
    gender tee_gender NOT NULL,
    course_rating DECIMAL(4,1) NOT NULL, -- USGA course rating: expected score for a scratch golfer
    slope_rating INT NOT NULL,           -- USGA slope: difficulty for a bogey golfer vs scratch (55–155)
    par INT NOT NULL                     -- Total par for all holes from this tee
);

-- Holes
-- Individual hole details per tee set. Par and stroke index can vary between tee sets.
-- stroke_index is the handicap allocation: hole with stroke_index=1 is hardest and gets
-- the first handicap stroke. UNIQUE (tee_id, hole_number) prevents duplicate hole entries.
CREATE TABLE holes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tee_id UUID NOT NULL REFERENCES tees(id) ON DELETE CASCADE,
    hole_number INT NOT NULL,          -- 1–18 (or 1–9)
    par INT NOT NULL,                  -- Expected strokes for this hole (3, 4, or 5)
    stroke_index INT NOT NULL,         -- Handicap allocation rank (1 = hardest, 18 = easiest)
    yardage INT,                       -- Distance in yards; nullable because some courses don't publish yardages
    UNIQUE (tee_id, hole_number)       -- Each hole number can only appear once per tee set
);

-- Events
-- The top-level container for any golf competition.
-- An event can be a league (ongoing season), tournament (one-off), or casual round.
-- There is no separate "leagues" table — event_type = 'league' serves that purpose.
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR NOT NULL,
    description TEXT,                              -- Optional longer description
    event_type event_type NOT NULL,                -- 'league', 'tournament', or 'casual'
    status event_status NOT NULL DEFAULT 'upcoming',
    start_date DATE,                               -- Nullable: some events don't have a fixed start date
    end_date DATE,                                 -- Nullable: single-day events may not have an end date
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Event Points Rules
-- Defines how many league points each finishing position earns in this event.
-- Example: 1st = 100 pts, 2nd = 80 pts, 3rd = 60 pts.
-- ON DELETE CASCADE: if an event is deleted, its points rules are deleted too.
-- UNIQUE (event_id, finish_position): each event can only have one rule per position.
CREATE TABLE event_points_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    finish_position INT NOT NULL,  -- 1 = first place, 2 = second, etc.
    points INT NOT NULL,
    UNIQUE (event_id, finish_position)
);

-- Event Players
-- Tracks which users belong to / participate in an event and their overall results.
-- For a "league" event, this is effectively the league membership list.
-- For a "tournament", this is the registration list.
--
-- The role column controls what the player can do within this event:
--   "organizer" — can edit, invite members, schedule rounds
--   "player"    — participant only
--
-- finish_position, total_gross_score, total_net_score, and total_points are all nullable
-- because they're only populated once the event is complete.
-- UNIQUE (event_id, user_id): a player can only be registered once per event.
CREATE TABLE event_players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role event_player_role NOT NULL DEFAULT 'player',  -- Permission level within this event
    status event_player_status NOT NULL DEFAULT 'registered',
    finish_position INT,       -- Nullable: set when event is finalized
    total_gross_score INT,     -- Nullable: sum of gross scores across all rounds
    total_net_score INT,       -- Nullable: sum of net scores (handicap-adjusted)
    total_points INT,          -- Nullable: league points earned based on finish position
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_id, user_id)
);

-- Rounds
-- A single day/session of golf within an event. Multi-round events (like a 4-round
-- tournament) have multiple rows here, each with a different round_number.
-- requires_handicap: when true, players need a handicap index before scores can be entered.
CREATE TABLE rounds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    course_id UUID NOT NULL REFERENCES courses(id),      -- No cascade: don't delete rounds if course is deleted
    default_tee_id UUID NOT NULL REFERENCES tees(id),   -- The tee set used by most players; individuals can override
    round_number INT NOT NULL DEFAULT 1,
    scheduled_date DATE NOT NULL,
    status round_status NOT NULL DEFAULT 'scheduled',
    scoring_format scoring_format NOT NULL,
    requires_handicap BOOLEAN NOT NULL DEFAULT FALSE,    -- Default false: handicap not required for casual rounds
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Round Players
-- Links an event_player to a specific round and tracks their per-round results.
-- A user must be an event_player before they can be a round_player.
-- tee_id is nullable so players can use a different tee than the round's default.
-- handicap_index and course_handicap are captured at the time of the round — a player's
-- handicap can change over time, so we snapshot it here for historical accuracy.
CREATE TABLE round_players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    event_player_id UUID NOT NULL REFERENCES event_players(id) ON DELETE CASCADE,
    tee_id UUID REFERENCES tees(id),          -- Nullable tee override
    handicap_index DECIMAL(4,1),              -- Nullable: player's WHS handicap index (e.g., 14.2)
    course_handicap INT,                      -- Nullable: calculated playing handicap for this course/tee
    finish_position INT,                      -- Nullable: set when round is finalized
    points_earned INT,                        -- Nullable: points from this specific round (if applicable)
    status round_player_status NOT NULL DEFAULT 'registered',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (round_id, event_player_id)        -- One entry per player per round
);

-- Scores
-- Records the strokes a player took on each individual hole.
-- Both gross (actual) and net (handicap-adjusted) scores are stored so either
-- can be used depending on the round's scoring_format.
-- entered_by tracks who submitted the score — could be the player, a group member, or a scorer.
-- UNIQUE (round_player_id, hole_number): one score per player per hole.
CREATE TABLE scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_player_id UUID NOT NULL REFERENCES round_players(id) ON DELETE CASCADE,
    hole_number INT NOT NULL,      -- 1–18
    gross_score INT NOT NULL,      -- Actual strokes taken
    net_score INT NOT NULL,        -- Gross score minus handicap strokes allocated to this hole
    entered_by UUID NOT NULL REFERENCES users(id),
    entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (round_player_id, hole_number)
);

-- Groups
-- A tee-time group: players who tee off together at the same time.
-- starting_hole supports "shotgun starts" where different groups begin on different holes
-- simultaneously — common in larger tournaments to speed up play.
CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    group_number INT NOT NULL,         -- Display order (group 1 tees off first)
    tee_time TIMESTAMPTZ,              -- Nullable: scheduled start time for this group
    starting_hole INT NOT NULL DEFAULT 1, -- Which hole the group begins on (1 for normal, other for shotgun)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Group Players
-- Join table: links round_players to their group for a given round.
-- Composite PK ensures each player can only be in one group per round.
CREATE TABLE group_players (
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    round_player_id UUID NOT NULL REFERENCES round_players(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, round_player_id)
);

-- Teams
-- Named teams for team-format rounds (scramble, best ball, etc.).
-- Teams belong to a round, not an event, because team compositions can vary per round.
CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
    name VARCHAR NOT NULL,         -- Display name (e.g., "Team A", "The Hackers")
    finish_position INT,           -- Nullable: set when the round is finalized
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Team Members
-- Join table: places a round_player on a team.
-- Composite PK prevents a player from being on two teams in the same round.
CREATE TABLE team_members (
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    round_player_id UUID NOT NULL REFERENCES round_players(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, round_player_id)
);

-- Team Scores
-- Stores the team's combined score for each hole in team-format rounds.
-- In a scramble, the whole team shares one score per hole — this table records it.
-- UNIQUE (team_id, hole_number): one team score per hole.
CREATE TABLE team_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    hole_number INT NOT NULL,
    gross_score INT NOT NULL,
    net_score INT NOT NULL,
    entered_by UUID NOT NULL REFERENCES users(id),
    entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (team_id, hole_number)
);

-- Indexes
-- Indexes speed up queries that filter or join on these columns. Without indexes,
-- PostgreSQL would scan every row in the table (a "full table scan") which is slow
-- on large datasets. We create indexes on foreign key columns and other frequently
-- queried fields. Primary keys are indexed automatically by PostgreSQL.
CREATE INDEX idx_event_players_event_id ON event_players(event_id);            -- "Show all players in an event"
CREATE INDEX idx_event_players_user_id ON event_players(user_id);              -- "Show all events a user is in"
CREATE INDEX idx_event_players_role ON event_players(event_id, role);          -- "Show all organizers of an event"
CREATE INDEX idx_rounds_event_id ON rounds(event_id);                          -- "Show all rounds for an event"
CREATE INDEX idx_round_players_round_id ON round_players(round_id);            -- "Show all players in a round"
CREATE INDEX idx_round_players_event_player_id ON round_players(event_player_id); -- "Find a round_player by event_player"
CREATE INDEX idx_scores_round_player_id ON scores(round_player_id);            -- "Show all scores for a player in a round"
CREATE INDEX idx_groups_round_id ON groups(round_id);                          -- "Show all groups in a round"
CREATE INDEX idx_teams_round_id ON teams(round_id);                            -- "Show all teams in a round"
CREATE INDEX idx_team_scores_team_id ON team_scores(team_id);                  -- "Show all hole scores for a team"
