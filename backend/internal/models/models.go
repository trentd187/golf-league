// Package models defines the data structures (models) that map to database tables.
// GORM uses these structs to generate SQL queries and map database rows back to Go values.
// The struct field tags (the backtick strings like `gorm:"..."`) tell GORM how to handle
// each field: its column type, constraints, default values, and relationships.
//
// The data model represents a golf competition platform where:
//   - Users join Events (leagues, tournaments, or casual rounds)
//   - Events contain Rounds played at Courses
//   - Rounds track Scores per player per hole
//   - Players can be grouped into Groups (tee times) or Teams
//
// There is no separate "league" concept — an Event with type "league" IS the league.
// This keeps the hierarchy simple: Event → Round → Score, regardless of competition type.
package models

import (
	"time"

	// uuid provides universally unique identifiers for primary keys.
	// Using UUIDs instead of auto-incrementing integers makes IDs safe to generate
	// client-side and avoids leaking record counts to end users.
	"github.com/google/uuid"
)

// --- Enums ---
// Go doesn't have a built-in enum keyword, so we simulate them using a named string type
// plus constants. This gives us type safety — you can't accidentally pass a UserRole
// where an EventStatus is expected — while keeping the values human-readable in the database.

// UserRole represents a user's global permission level across the entire platform.
type UserRole string

const (
	UserRoleAdmin   UserRole = "admin"   // Full access: manage users, events, everything
	UserRoleManager UserRole = "manager" // Can create and manage events
	UserRoleUser    UserRole = "user"    // Regular player: can join events and record scores
)

// EventType describes what kind of golf competition is being organized.
// There is no separate "league" model — an event with type "league" IS the league.
type EventType string

const (
	EventTypeLeague     EventType = "league"     // An ongoing, multi-round season with accumulated standings
	EventTypeTournament EventType = "tournament" // A competitive one-off event (1 or more rounds)
	EventTypeCasual     EventType = "casual"     // Informal round with friends; no standings, no points
)

// EventStatus tracks the lifecycle of an event.
type EventStatus string

const (
	EventStatusUpcoming  EventStatus = "upcoming"  // Event is scheduled but hasn't started
	EventStatusActive    EventStatus = "active"    // Event is currently in progress
	EventStatusCompleted EventStatus = "completed" // Event has finished
	EventStatusCancelled EventStatus = "cancelled" // Event was cancelled before completion
)

// EventPlayerRole controls what a user can do within a specific event.
// This is separate from UserRole (which is a global platform role).
// An "organizer" of an event can edit it, invite members, and schedule rounds.
// A "player" can participate but not manage.
type EventPlayerRole string

const (
	EventPlayerRoleOrganizer EventPlayerRole = "organizer" // Can manage this event
	EventPlayerRolePlayer    EventPlayerRole = "player"    // Participant only
)

// EventPlayerStatus tracks a player's participation state in an event.
type EventPlayerStatus string

const (
	EventPlayerStatusInvited    EventPlayerStatus = "invited"    // Invited but hasn't confirmed
	EventPlayerStatusRegistered EventPlayerStatus = "registered" // Confirmed participation
	EventPlayerStatusWithdrawn  EventPlayerStatus = "withdrawn"  // Withdrew before or during the event
	EventPlayerStatusCompleted  EventPlayerStatus = "completed"  // Finished the event
)

// RoundStatus tracks the lifecycle of a single round within an event.
type RoundStatus string

const (
	RoundStatusScheduled RoundStatus = "scheduled" // Round is on the calendar but not started
	RoundStatusActive    RoundStatus = "active"    // Round is currently being played
	RoundStatusCompleted RoundStatus = "completed" // Round has finished; scores are final
)

// ScoringFormat describes how a round is scored.
// Different formats have very different rules for determining a winner.
type ScoringFormat string

const (
	ScoringFormatStroke     ScoringFormat = "stroke"     // Fewest total strokes wins
	ScoringFormatNetStroke  ScoringFormat = "net_stroke" // Stroke play adjusted by handicap
	ScoringFormatStableford ScoringFormat = "stableford" // Points per hole based on score vs par
	ScoringFormatSkins      ScoringFormat = "skins"      // Each hole is worth money; ties carry over
	ScoringFormatMatchPlay  ScoringFormat = "match_play" // Win/loss per hole, not total strokes
	ScoringFormatScramble   ScoringFormat = "scramble"   // Team format: all play from the best shot
	ScoringFormatBestBall   ScoringFormat = "best_ball"  // Team format: count only the best score per hole
)

// RoundPlayerStatus tracks a player's state in a single round.
type RoundPlayerStatus string

const (
	RoundPlayerStatusRegistered RoundPlayerStatus = "registered" // Signed up for the round
	RoundPlayerStatusActive     RoundPlayerStatus = "active"     // Currently playing
	RoundPlayerStatusWithdrawn  RoundPlayerStatus = "withdrawn"  // Withdrew from this round
	RoundPlayerStatusCompleted  RoundPlayerStatus = "completed"  // Finished this round
)

// TeeGender indicates which gender a set of tees is rated for.
// Golf courses rate tees separately because different tee boxes have different distances.
type TeeGender string

const (
	TeeGenderMens   TeeGender = "mens"
	TeeGenderWomens TeeGender = "womens"
	TeeGenderUnisex TeeGender = "unisex" // No gender designation — open to all
)

// --- Models ---
// Each struct below maps to a database table. GORM uses the struct name (snake_cased and
// pluralized) as the table name by default: User -> users, Event -> events, etc.

// User represents a registered person in the system.
// Users are created automatically the first time a Clerk-authenticated user hits the API.
// The ClerkID links our internal record to Clerk's identity system.
type User struct {
	ID          uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"` // UUID primary key; the DB generates it automatically
	ClerkID     *string   `gorm:"uniqueIndex:idx_users_clerk_id"`                  // Clerk's user ID (e.g. "user_2abc123"); pointer = nullable for legacy rows
	DisplayName string    `gorm:"not null"`                                        // The name shown in the app; populated from the Clerk JWT "name" claim
	Email       string    `gorm:"uniqueIndex;not null"`                            // Unique email; populated from the Clerk JWT "email" claim
	AvatarURL   *string                                                            // Optional profile picture URL; pointer means it can be NULL in the DB
	Role        UserRole  `gorm:"type:user_role;not null;default:'user'"`          // Global role; synced from Clerk publicMetadata via the JWT "role" claim
	CreatedAt   time.Time                                                          // GORM automatically sets this on create
	UpdatedAt   time.Time                                                          // GORM automatically updates this on every save
}

// Event is the top-level container for any golf competition.
// It can be a league (ongoing season), tournament (one-off), or casual round.
//
// There is no separate "League" model. An Event with EventType = "league" IS the league.
// This keeps the data hierarchy clean: Event → Rounds → Scores.
//
// Who belongs to an event is tracked via EventPlayer (below).
// Who can manage an event is controlled by EventPlayer.Role = "organizer".
type Event struct {
	ID          uuid.UUID   `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	Name        string      `gorm:"not null"`
	Description *string     // Optional long-form description; pointer = nullable
	EventType   EventType   `gorm:"type:event_type;not null"`
	Status      EventStatus `gorm:"type:event_status;not null;default:'upcoming'"`
	StartDate   *time.Time  // Optional start date; pointer = nullable (some events don't have a fixed date)
	EndDate     *time.Time  // Optional end date; pointer = nullable
	CreatedBy   uuid.UUID   `gorm:"type:uuid;not null"`       // Foreign key: which user created this event
	Creator     User        `gorm:"foreignKey:CreatedBy"`     // GORM relationship: preloads the User struct when queried
	CreatedAt   time.Time
	UpdatedAt   time.Time
	PointsRules []EventPointsRule `gorm:"foreignKey:EventID"` // Points awarded per finishing position
	Players     []EventPlayer     `gorm:"foreignKey:EventID"` // Players/members registered for this event
	Rounds      []Round           `gorm:"foreignKey:EventID"` // Individual rounds that make up this event
}

// EventPointsRule defines how many league points a player earns for a given finishing position.
// For example: 1st place = 100 points, 2nd place = 80 points, etc.
// The unique index (idx_event_position) prevents duplicate rules for the same event + position.
type EventPointsRule struct {
	ID             uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	EventID        uuid.UUID `gorm:"type:uuid;not null;uniqueIndex:idx_event_position"` // Combined unique index with FinishPosition
	Event          Event     `gorm:"foreignKey:EventID"`
	FinishPosition int       `gorm:"not null;uniqueIndex:idx_event_position"` // 1 = first place, 2 = second place, etc.
	Points         int       `gorm:"not null"`
}

// EventPlayer links a User to an Event.
// For a "league" event: this is the membership list (who belongs to the league).
// For a "tournament": this is the registration list (who is competing).
//
// The Role field controls what the user can do within this event:
//   - EventPlayerRoleOrganizer: can edit the event, invite members, schedule rounds
//   - EventPlayerRolePlayer: participant only
//
// The unique index (idx_event_user) ensures a user can only be an event_player once per event.
type EventPlayer struct {
	ID              uuid.UUID         `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	EventID         uuid.UUID         `gorm:"type:uuid;not null;uniqueIndex:idx_event_user"` // Combined unique index with UserID
	Event           Event             `gorm:"foreignKey:EventID"`
	UserID          uuid.UUID         `gorm:"type:uuid;not null;uniqueIndex:idx_event_user"`
	User            User              `gorm:"foreignKey:UserID"`
	Role            EventPlayerRole   `gorm:"type:event_player_role;not null;default:'player'"` // Permission level within this event
	Status          EventPlayerStatus `gorm:"type:event_player_status;not null;default:'registered'"`
	FinishPosition  *int              // Set once the event is completed; nullable until then
	TotalGrossScore *int              // Sum of all gross scores across rounds
	TotalNetScore   *int              // Sum of all net scores (gross minus handicap strokes)
	TotalPoints     *int              // League points earned based on finish position
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// Round represents a single day/round of play within an Event.
// An event might have 1 round (casual) or many rounds (league season, multi-day tournament).
type Round struct {
	ID               uuid.UUID     `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	EventID          uuid.UUID     `gorm:"type:uuid;not null"`
	Event            Event         `gorm:"foreignKey:EventID"`
	CourseID         uuid.UUID     `gorm:"type:uuid;not null"`
	Course           Course        `gorm:"foreignKey:CourseID"`
	DefaultTeeID     uuid.UUID     `gorm:"type:uuid;not null"`        // The tee set most players use; individuals can override in RoundPlayer
	DefaultTee       Tee           `gorm:"foreignKey:DefaultTeeID"`
	RoundNumber      int           `gorm:"not null;default:1"`        // 1 for first round, 2 for second, etc.
	ScheduledDate    time.Time     `gorm:"not null"`
	Status           RoundStatus   `gorm:"type:round_status;not null;default:'scheduled'"`
	ScoringFormat    ScoringFormat `gorm:"type:scoring_format;not null"`
	RequiresHandicap bool          `gorm:"not null;default:false"` // If true, players must have a handicap index before scores can be entered
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// RoundPlayer links an EventPlayer to a specific Round and stores their per-round results.
// A user must be an EventPlayer before they can be a RoundPlayer.
// It also records any tee override and handicap info specific to this round.
type RoundPlayer struct {
	ID             uuid.UUID         `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	RoundID        uuid.UUID         `gorm:"type:uuid;not null;uniqueIndex:idx_round_event_player"` // Composite unique: one entry per player per round
	Round          Round             `gorm:"foreignKey:RoundID"`
	EventPlayerID  uuid.UUID         `gorm:"type:uuid;not null;uniqueIndex:idx_round_event_player"`
	EventPlayer    EventPlayer       `gorm:"foreignKey:EventPlayerID"`
	TeeID          *uuid.UUID        `gorm:"type:uuid"`           // Optional tee override; if nil, the round's DefaultTee is used
	Tee            *Tee              `gorm:"foreignKey:TeeID"`
	HandicapIndex  *float64          `gorm:"type:decimal(4,1)"` // Player's WHS handicap index at time of round (e.g., 14.2)
	CourseHandicap *int              // Calculated playing handicap for this specific course and tee
	FinishPosition *int              // Player's finish position in this round
	PointsEarned   *int              // Points earned in this round (if applicable to the scoring format)
	Status         RoundPlayerStatus `gorm:"type:round_player_status;not null;default:'registered'"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Score records the strokes a player took on a single hole during a round.
// Both gross (actual strokes) and net (handicap-adjusted) scores are stored
// so either can be used depending on the scoring format.
type Score struct {
	ID            uuid.UUID   `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	RoundPlayerID uuid.UUID   `gorm:"type:uuid;not null;uniqueIndex:idx_round_player_hole"` // Composite unique: one score per player per hole
	RoundPlayer   RoundPlayer `gorm:"foreignKey:RoundPlayerID"`
	HoleNumber    int         `gorm:"not null;uniqueIndex:idx_round_player_hole"` // 1–18
	GrossScore    int         `gorm:"not null"`                                   // Actual strokes taken
	NetScore      int         `gorm:"not null"`                                   // Gross score minus handicap strokes for this hole
	EnteredBy     uuid.UUID   `gorm:"type:uuid;not null"`                         // Which user entered this score (could be the player, a group member, or a scorer)
	Enterer       User        `gorm:"foreignKey:EnteredBy"`
	EnteredAt     time.Time   `gorm:"autoCreateTime"`  // Set automatically by GORM on insert
	UpdatedAt     time.Time   `gorm:"autoUpdateTime"`  // Updated automatically by GORM on every save
}

// Group represents a tee-time group — players who tee off together.
// Grouping players allows the app to display tee sheets and pairings.
type Group struct {
	ID           uuid.UUID  `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	RoundID      uuid.UUID  `gorm:"type:uuid;not null"`
	Round        Round      `gorm:"foreignKey:RoundID"`
	GroupNumber  int        `gorm:"not null"`        // Display order: group 1 tees off first, etc.
	TeeTime      *time.Time                          // Optional scheduled start time for this group
	StartingHole int        `gorm:"not null;default:1"` // Which hole the group starts on (shotgun starts begin on different holes)
	CreatedAt    time.Time
}

// GroupPlayer is a join table placing a RoundPlayer into a Group.
// Composite primary key prevents a player from being in two groups in the same round.
type GroupPlayer struct {
	GroupID       uuid.UUID   `gorm:"type:uuid;primaryKey"`
	RoundPlayerID uuid.UUID   `gorm:"type:uuid;primaryKey"`
	Group         Group       `gorm:"foreignKey:GroupID"`
	RoundPlayer   RoundPlayer `gorm:"foreignKey:RoundPlayerID"`
}

// Team represents a named team in a team-format round (scramble, best ball, etc.).
// Teams belong to a specific round, not an event, because team compositions can
// change between rounds.
type Team struct {
	ID             uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	RoundID        uuid.UUID `gorm:"type:uuid;not null"`
	Round          Round     `gorm:"foreignKey:RoundID"`
	Name           string    `gorm:"not null"`    // Display name for the team (e.g., "Team A", "The Hackers")
	FinishPosition *int                            // Nullable until the round is complete
	CreatedAt      time.Time
}

// TeamMember is a join table placing a RoundPlayer onto a Team.
type TeamMember struct {
	TeamID        uuid.UUID   `gorm:"type:uuid;primaryKey"`
	RoundPlayerID uuid.UUID   `gorm:"type:uuid;primaryKey"`
	Team          Team        `gorm:"foreignKey:TeamID"`
	RoundPlayer   RoundPlayer `gorm:"foreignKey:RoundPlayerID"`
}

// TeamScore records the team's combined score on a single hole.
// Used in formats like scramble where one score represents the whole team.
// The unique index (idx_team_hole) ensures only one score per team per hole.
type TeamScore struct {
	ID         uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	TeamID     uuid.UUID `gorm:"type:uuid;not null;uniqueIndex:idx_team_hole"`
	Team       Team      `gorm:"foreignKey:TeamID"`
	HoleNumber int       `gorm:"not null;uniqueIndex:idx_team_hole"` // 1–18
	GrossScore int       `gorm:"not null"`
	NetScore   int       `gorm:"not null"`
	EnteredBy  uuid.UUID `gorm:"type:uuid;not null"` // Who submitted this score
	Enterer    User      `gorm:"foreignKey:EnteredBy"`
	EnteredAt  time.Time `gorm:"autoCreateTime"`
	UpdatedAt  time.Time `gorm:"autoUpdateTime"`
}

// Course represents a golf course where rounds are played.
type Course struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	Name      string    `gorm:"not null"`
	City      string    `gorm:"not null;default:''"` // Defaults to empty string; can be filled in later
	State     string    `gorm:"not null;default:''"` // Defaults to empty string; can be filled in later
	HoleCount int       `gorm:"not null;default:18"` // Most courses have 18 holes; some have 9
	CreatedAt time.Time
	UpdatedAt time.Time
	Tees      []Tee `gorm:"foreignKey:CourseID"` // One-to-many: a course has many sets of tees (different distances/ratings)
}

// Tee represents one set of tee boxes on a course (e.g., "Blue", "White", "Red").
// Each tee set has its own course rating, slope, and par — used for handicap calculations.
type Tee struct {
	ID           uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	CourseID     uuid.UUID `gorm:"type:uuid;not null"`
	Course       Course    `gorm:"foreignKey:CourseID"`
	Name         string    `gorm:"not null"`                           // e.g., "Blue", "White", "Red", "Default"
	Gender       TeeGender `gorm:"type:tee_gender;not null"`
	CourseRating float64   `gorm:"type:decimal(4,1);not null"` // USGA course rating (e.g., 72.4) — represents the expected score for a scratch golfer
	SlopeRating  int       `gorm:"not null"`                   // USGA slope rating (55–155) — measures difficulty for bogey golfers relative to scratch
	Par          int       `gorm:"not null"`                   // Expected score for the full set of holes on these tees
	Holes        []Hole    `gorm:"foreignKey:TeeID"`           // One-to-many: each tee set has individual hole details
}

// Hole stores per-hole details for a specific set of tees.
// Par and StrokeIndex can vary between tee sets on the same course.
type Hole struct {
	ID          uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	TeeID       uuid.UUID `gorm:"type:uuid;not null"`
	Tee         Tee       `gorm:"foreignKey:TeeID"`
	HoleNumber  int       `gorm:"not null"`      // 1–18 (or 1–9 for a 9-hole course)
	Par         int       `gorm:"not null"`      // Expected strokes for this hole (typically 3, 4, or 5)
	StrokeIndex int       `gorm:"not null"`      // Handicap allocation: hole 1 = hardest (gets first handicap stroke), 18 = easiest
	Yardage     *int                              // Distance in yards from this tee box; optional because some courses don't publish yardages
}
