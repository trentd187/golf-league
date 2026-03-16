// Package models defines the data structures that map to database tables.
// GORM uses struct field tags (backtick strings) to define column types,
// constraints, defaults, and relationships.
//
// Hierarchy: User → Event → Round → Score
// There is no separate "league" concept — an Event with type "league" IS the league.
package models

import (
	"time"

	// uuid provides universally unique identifiers for primary keys.
	// Using UUIDs instead of auto-incrementing integers avoids leaking record counts
	// and makes IDs safe to generate client-side.
	"github.com/google/uuid"
)

// --- Enums ---
// Go simulates enums with a named string type plus constants, giving type safety
// without sacrificing human-readable values in the database.

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
	EventTypeLeague     EventType = "league"
	EventTypeTournament EventType = "tournament"
	EventTypeCasual     EventType = "casual"
)

// EventStatus tracks the lifecycle of an event.
// "upcoming" was removed — new events start as "active" immediately.
type EventStatus string

const (
	EventStatusActive    EventStatus = "active"
	EventStatusCompleted EventStatus = "completed"
	EventStatusCancelled EventStatus = "cancelled"
)

// EventPlayerRole controls what a user can do within a specific event.
// This is separate from UserRole (global platform role).
type EventPlayerRole string

const (
	EventPlayerRoleOrganizer EventPlayerRole = "organizer" // Can manage this event
	EventPlayerRolePlayer    EventPlayerRole = "player"    // Participant only
)

// EventPlayerStatus tracks a player's participation state in an event.
type EventPlayerStatus string

const (
	EventPlayerStatusInvited    EventPlayerStatus = "invited"
	EventPlayerStatusRegistered EventPlayerStatus = "registered"
	EventPlayerStatusWithdrawn  EventPlayerStatus = "withdrawn"
	EventPlayerStatusCompleted  EventPlayerStatus = "completed"
)

// RoundStatus tracks the lifecycle of a single round within an event.
type RoundStatus string

const (
	RoundStatusScheduled RoundStatus = "scheduled"
	RoundStatusActive    RoundStatus = "active"
	RoundStatusCompleted RoundStatus = "completed"
)

// ScoringFormat describes how a round is scored.
// Irish Rumble is a team format where the best net score on each hole counts;
// the sub-variant determines whether holes are scored as stroke or stableford points.
type ScoringFormat string

const (
	ScoringFormatStroke                ScoringFormat = "stroke"
	ScoringFormatStableford            ScoringFormat = "stableford"
	ScoringFormatIrishRumble           ScoringFormat = "irish_rumble"
	ScoringFormatIrishRumbleStableford ScoringFormat = "irish_rumble_stableford"
	ScoringFormatScramble              ScoringFormat = "scramble"
	ScoringFormatMatchPlay             ScoringFormat = "match_play"
)

// RoundPlayerStatus tracks a player's state in a single round.
type RoundPlayerStatus string

const (
	RoundPlayerStatusRegistered RoundPlayerStatus = "registered"
	RoundPlayerStatusActive     RoundPlayerStatus = "active"
	RoundPlayerStatusWithdrawn  RoundPlayerStatus = "withdrawn"
	RoundPlayerStatusCompleted  RoundPlayerStatus = "completed"
)

// TeeGender indicates which gender a set of tees is rated for.
// Golf courses rate tees separately because different tee boxes have different distances.
type TeeGender string

const (
	TeeGenderMens   TeeGender = "mens"
	TeeGenderWomens TeeGender = "womens"
	TeeGenderUnisex TeeGender = "unisex"
)

// --- Models ---
// Each struct maps to a database table. GORM derives the table name by snake-casing
// and pluralizing the struct name: User → users, Event → events, etc.

// User represents a registered person in the system.
// Created automatically the first time a Clerk-authenticated user hits the API.
type User struct {
	ID          uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"` // DB generates the UUID
	ClerkID     *string   `gorm:"uniqueIndex:idx_users_clerk_id"`                 // Pointer = nullable for legacy rows
	DisplayName string    `gorm:"not null"`
	Email       string    `gorm:"uniqueIndex;not null"`
	AvatarURL   *string   // Pointer = nullable in DB
	Role        UserRole  `gorm:"type:user_role;not null;default:'user'"`
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Event is the top-level container for any golf competition.
// There is no separate "League" model — an Event with EventType = "league" IS the league.
// Who can manage an event is controlled by EventPlayer.Role = "organizer".
type Event struct {
	ID          uuid.UUID   `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	Name        string      `gorm:"not null"`
	Description *string     // Pointer = nullable
	EventType   EventType   `gorm:"type:event_type;not null"`
	Status      EventStatus `gorm:"type:event_status;not null;default:'active'"`
	StartDate   *time.Time  // Pointer = nullable (some events don't have a fixed date)
	EndDate     *time.Time  // Pointer = nullable
	CreatedBy   uuid.UUID   `gorm:"type:uuid;not null"`
	Creator     User        `gorm:"foreignKey:CreatedBy"`
	CreatedAt   time.Time
	UpdatedAt   time.Time
	PointsRules []EventPointsRule `gorm:"foreignKey:EventID"`
	Players     []EventPlayer     `gorm:"foreignKey:EventID"`
	Rounds      []Round           `gorm:"foreignKey:EventID"`
}

// EventPointsRule defines how many league points a player earns for a given finishing position.
// The uniqueIndex:idx_event_position tag creates a composite unique constraint on (EventID, FinishPosition).
type EventPointsRule struct {
	ID             uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	EventID        uuid.UUID `gorm:"type:uuid;not null;uniqueIndex:idx_event_position"`
	Event          Event     `gorm:"foreignKey:EventID"`
	FinishPosition int       `gorm:"not null;uniqueIndex:idx_event_position"`
	Points         int       `gorm:"not null"`
}

// EventPlayer links a User to an Event and records their role and status within it.
// The uniqueIndex:idx_event_user tag ensures a user can only be an event_player once per event.
type EventPlayer struct {
	ID              uuid.UUID         `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	EventID         uuid.UUID         `gorm:"type:uuid;not null;uniqueIndex:idx_event_user"`
	Event           Event             `gorm:"foreignKey:EventID"`
	UserID          uuid.UUID         `gorm:"type:uuid;not null;uniqueIndex:idx_event_user"`
	User            User              `gorm:"foreignKey:UserID"`
	Role            EventPlayerRole   `gorm:"type:event_player_role;not null;default:'player'"`
	Status          EventPlayerStatus `gorm:"type:event_player_status;not null;default:'registered'"`
	FinishPosition  *int              // Nullable until event is completed
	TotalGrossScore *int
	TotalNetScore   *int
	TotalPoints     *int
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// Round represents a single day/round of play within an Event.
type Round struct {
	ID               uuid.UUID     `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	EventID          uuid.UUID     `gorm:"type:uuid;not null"`
	Event            Event         `gorm:"foreignKey:EventID"`
	CourseID         uuid.UUID     `gorm:"type:uuid;not null"`
	Course           Course        `gorm:"foreignKey:CourseID"`
	DefaultTeeID     uuid.UUID     `gorm:"type:uuid;not null"` // Individuals can override in RoundPlayer
	DefaultTee       Tee           `gorm:"foreignKey:DefaultTeeID"`
	Name             string        `gorm:"not null;default:'Round'"`
	RoundNumber      int           `gorm:"not null;default:1"`
	ScheduledDate    time.Time     `gorm:"not null"`
	Status           RoundStatus   `gorm:"type:round_status;not null;default:'scheduled'"`
	ScoringFormat    ScoringFormat `gorm:"type:scoring_format;not null"`
	RequiresHandicap bool          `gorm:"not null;default:false"` // Blocks score entry until handicap is set
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// RoundPlayer links an EventPlayer to a specific Round and stores per-round results.
// The uniqueIndex:idx_round_event_player ensures one entry per player per round.
type RoundPlayer struct {
	ID             uuid.UUID   `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	RoundID        uuid.UUID   `gorm:"type:uuid;not null;uniqueIndex:idx_round_event_player"`
	Round          Round       `gorm:"foreignKey:RoundID"`
	EventPlayerID  uuid.UUID   `gorm:"type:uuid;not null;uniqueIndex:idx_round_event_player"`
	EventPlayer    EventPlayer `gorm:"foreignKey:EventPlayerID"`
	TeeID          *uuid.UUID  `gorm:"type:uuid"` // Optional override; nil = use round's DefaultTee
	Tee            *Tee        `gorm:"foreignKey:TeeID"`
	HandicapIndex  *float64    `gorm:"type:decimal(4,1)"` // Player's WHS index at time of round (optional, informational)
	CourseHandicap *int        // Playing handicap for this specific course and tee
	FinishPosition *int
	PointsEarned   *int
	Status         RoundPlayerStatus `gorm:"type:round_player_status;not null;default:'registered'"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Score records the strokes a player took on a single hole during a round.
// The uniqueIndex:idx_round_player_hole ensures one score per player per hole.
type Score struct {
	ID            uuid.UUID   `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	RoundPlayerID uuid.UUID   `gorm:"type:uuid;not null;uniqueIndex:idx_round_player_hole"`
	RoundPlayer   RoundPlayer `gorm:"foreignKey:RoundPlayerID"`
	HoleNumber    int         `gorm:"not null;uniqueIndex:idx_round_player_hole"` // 1–18
	GrossScore    int         `gorm:"not null"`
	NetScore      int         `gorm:"not null"` // Gross minus handicap strokes for this hole
	EnteredBy     uuid.UUID   `gorm:"type:uuid;not null"`
	Enterer       User        `gorm:"foreignKey:EnteredBy"`
	EnteredAt     time.Time   `gorm:"autoCreateTime"`
	UpdatedAt     time.Time   `gorm:"autoUpdateTime"`
}

// HoleStat records advanced per-hole statistics for one player during a round.
// Stored in a separate table from scores so stats can be entered without a
// gross score existing for that hole.
// The uniqueIndex ensures one stat row per player per hole.
type HoleStat struct {
	ID            uuid.UUID   `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	RoundPlayerID uuid.UUID   `gorm:"type:uuid;not null;uniqueIndex:idx_hole_stat_player_hole"`
	RoundPlayer   RoundPlayer `gorm:"foreignKey:RoundPlayerID"`
	HoleNumber    int         `gorm:"not null;uniqueIndex:idx_hole_stat_player_hole"` // 1–18
	// GIR (Green in Regulation): "hit", "miss", or "na" (not applicable)
	GIR *string `gorm:"column:gir;type:text"`
	// GIRMissDirection: which side the approach missed — "short", "left", "right", "long"
	GIRMissDirection *string `gorm:"column:gir_miss_direction;type:text"`
	// FIR (Fairway in Regulation): true = hit the fairway, false = missed
	FIR *bool `gorm:"column:fir;type:boolean"`
	// FIRMissDirection: which side the drive missed
	FIRMissDirection  *string   `gorm:"column:fir_miss_direction;type:text"`
	Putts             *int      `gorm:"column:putts;type:int"`
	FirstPuttDistance *int      `gorm:"column:first_putt_distance;type:int"` // feet
	PuttDistanceMade  *int      `gorm:"column:putt_distance_made;type:int"`  // feet
	EnteredAt         time.Time `gorm:"autoCreateTime"`
	UpdatedAt         time.Time `gorm:"autoUpdateTime"`
}

// Group represents a tee-time group — players who tee off together.
type Group struct {
	ID           uuid.UUID  `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	RoundID      uuid.UUID  `gorm:"type:uuid;not null"`
	Round        Round      `gorm:"foreignKey:RoundID"`
	GroupNumber  int        `gorm:"not null"`
	TeeTime      *time.Time // Optional scheduled start time
	StartingHole int        `gorm:"not null;default:1"` // Shotgun starts begin on different holes
	CreatedAt    time.Time
}

// GroupPlayer is a join table placing a RoundPlayer into a Group.
// Composite primary key (GroupID + RoundPlayerID) prevents a player from being in two groups.
type GroupPlayer struct {
	GroupID       uuid.UUID   `gorm:"type:uuid;primaryKey"`
	RoundPlayerID uuid.UUID   `gorm:"type:uuid;primaryKey"`
	Group         Group       `gorm:"foreignKey:GroupID"`
	RoundPlayer   RoundPlayer `gorm:"foreignKey:RoundPlayerID"`
}

// Team represents a named team in a team-format round (scramble, best ball, etc.).
// Teams belong to a round, not an event, because compositions can change between rounds.
type Team struct {
	ID             uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	RoundID        uuid.UUID `gorm:"type:uuid;not null"`
	Round          Round     `gorm:"foreignKey:RoundID"`
	Name           string    `gorm:"not null"`
	FinishPosition *int      // Nullable until the round is complete
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
// The uniqueIndex:idx_team_hole ensures one score per team per hole.
type TeamScore struct {
	ID         uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	TeamID     uuid.UUID `gorm:"type:uuid;not null;uniqueIndex:idx_team_hole"`
	Team       Team      `gorm:"foreignKey:TeamID"`
	HoleNumber int       `gorm:"not null;uniqueIndex:idx_team_hole"` // 1–18
	GrossScore int       `gorm:"not null"`
	NetScore   int       `gorm:"not null"`
	EnteredBy  uuid.UUID `gorm:"type:uuid;not null"`
	Enterer    User      `gorm:"foreignKey:EnteredBy"`
	EnteredAt  time.Time `gorm:"autoCreateTime"`
	UpdatedAt  time.Time `gorm:"autoUpdateTime"`
}

// Course represents a golf course where rounds are played.
type Course struct {
	ID             uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	Name           string    `gorm:"not null"`
	City           string    `gorm:"not null;default:''"`
	State          string    `gorm:"not null;default:''"`
	HoleCount      int       `gorm:"not null;default:18"`
	ExternalSource string    `gorm:"not null;default:''"` // e.g. "golfcourseapi"; empty for manually-entered courses
	ExternalID     string    `gorm:"not null;default:''"` // Course ID in the external system
	CreatedAt      time.Time
	UpdatedAt      time.Time
	Tees           []Tee `gorm:"foreignKey:CourseID"`
}

// Tee represents one set of tee boxes on a course (e.g. "Blue", "White", "Red").
// Each tee set has its own course rating, slope, and par — used for handicap calculations.
type Tee struct {
	ID           uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	CourseID     uuid.UUID `gorm:"type:uuid;not null"`
	Course       Course    `gorm:"foreignKey:CourseID"`
	Name         string    `gorm:"not null"`
	Gender       TeeGender `gorm:"type:tee_gender;not null"`
	CourseRating float64   `gorm:"type:decimal(4,1);not null"` // Expected score for a scratch golfer (e.g. 72.4)
	SlopeRating  int       `gorm:"not null"`                   // USGA slope (55–155): difficulty for bogey golfers vs scratch
	Par          int       `gorm:"not null"`
	Holes        []Hole    `gorm:"foreignKey:TeeID"`
}

// Hole stores per-hole details for a specific set of tees.
// Par and StrokeIndex can vary between tee sets on the same course.
type Hole struct {
	ID          uuid.UUID `gorm:"type:uuid;primaryKey;default:gen_random_uuid()"`
	TeeID       uuid.UUID `gorm:"type:uuid;not null"`
	Tee         Tee       `gorm:"foreignKey:TeeID"`
	HoleNumber  int       `gorm:"not null"` // 1–18
	Par         int       `gorm:"not null"`
	StrokeIndex int       `gorm:"not null"` // Handicap allocation: hole 1 = hardest, 18 = easiest
	Yardage     *int      // Pointer = nullable (some courses don't publish yardages)
}
