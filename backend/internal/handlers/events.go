// Package handlers contains HTTP route handler functions for the Golf League API.
// This file handles all /api/v1/events routes:
//   GET    /events                        — list events (filtered by membership)
//   POST   /events                        — create a new event
//   GET    /events/:id                    — get event detail + members list
//   PATCH  /events/:id                    — update event name/description/dates
//   GET    /events/:id/members            — list all members of an event
//   POST   /events/:id/members            — add a member to an event
//   DELETE /events/:id/members/:userId    — remove a member from an event
//   GET    /events/:id/rounds             — list rounds for an event
//   POST   /events/:id/rounds             — schedule a new round
//
// An "event" is the top-level container for any golf competition. It can be:
//   - "league"     — an ongoing, multi-round season with accumulated standings
//   - "tournament" — a one-off competitive event (1 or more rounds)
//   - "casual"     — informal round with friends; no standings, no points
//
// Each exported function follows the "handler factory" pattern: it takes a *gorm.DB
// and returns a fiber.Handler (a function that handles a single HTTP request).
// This lets us inject the database without using global variables.
//
// --- Permission model ---
// Two layers of access control are used:
//
//  1. Route-level (middleware.RequireRole): controls who can call certain routes at all.
//     Only "admin" and "manager" global roles can create events (POST /events).
//     All authenticated users can read events (GET /events).
//
//  2. Resource-level (isEventOrganizer, defined below): controls who can modify
//     a specific event (edit, invite members, schedule rounds).
//     - "admin" global role → can manage ANY event (full platform access).
//     - "manager" global role → can ONLY manage events where they hold the
//       "organizer" event_player role (granted automatically when they create an event,
//       or manually by another organizer adding them with that role).
//     - "user" global role → same rule as manager for event-level access.
//
// This means a manager cannot edit events created by other people unless the
// other event's organizer has explicitly granted them the organizer role.
package handlers

import (
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
)

// EventResponse is what we send back to the mobile app.
// We use a dedicated response struct (instead of the raw GORM model) so we control
// exactly what fields are serialised to JSON and can add computed fields like MemberCount.
type EventResponse struct {
	ID          string  `json:"id"`           // The event's UUID as a string
	Name        string  `json:"name"`         // Event display name
	Description *string `json:"description"`  // Optional description; null if not set
	EventType   string  `json:"event_type"`   // "league", "tournament", or "casual"
	Status      string  `json:"status"`       // "upcoming", "active", "completed", "cancelled"
	StartDate   *string `json:"start_date"`   // ISO 8601 date string or null
	EndDate     *string `json:"end_date"`     // ISO 8601 date string or null
	CreatorName string  `json:"creator_name"` // Display name of the user who created the event
	MemberCount int64   `json:"member_count"` // How many players/members are in this event
	CreatedAt   string  `json:"created_at"`   // ISO 8601 timestamp string
}

// CreateEventRequest is the JSON body we expect on POST /api/v1/events.
type CreateEventRequest struct {
	Name        string  `json:"name"`        // Required: the event's name
	Description *string `json:"description"` // Optional: longer description
	EventType   string  `json:"event_type"`  // Required: "league", "tournament", or "casual"
	StartDate   *string `json:"start_date"`  // Optional: "YYYY-MM-DD"
	EndDate     *string `json:"end_date"`    // Optional: "YYYY-MM-DD"
}

// formatOptionalDate converts a *time.Time to a *string in "2006-01-02" format.
// Returns nil if the input is nil (preserving the nullable property in the JSON response).
func formatOptionalDate(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format("2006-01-02")
	return &s
}

// parseOptionalDate parses an optional date string ("YYYY-MM-DD") into a *time.Time.
// Returns nil if the input string pointer is nil or empty.
// Returns an error if the string is non-empty but not a valid date.
func parseOptionalDate(s *string) (*time.Time, error) {
	if s == nil || *s == "" {
		return nil, nil
	}
	t, err := time.Parse("2006-01-02", *s)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// GetEvents returns a handler for GET /api/v1/events.
// - Admins see all events in the system.
// - Everyone else sees only events they are an event_player of.
// - Optional query param: ?type=league or ?type=tournament to filter by event_type.
func GetEvents(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Read the current user's ID and role from the request context.
		// These were set by the Auth middleware earlier in the request chain.
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)

		// Parse the string UUID back into a uuid.UUID for the database query
		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "invalid user ID",
			})
		}

		// Optional filter: ?type=league, ?type=tournament, ?type=casual
		typeFilter := c.Query("type") // empty string if not provided

		// Preload("Creator") tells GORM to automatically fetch the related User record
		// for each event's CreatedBy foreign key. This avoids N+1 queries.
		var events []models.Event
		query := db.Preload("Creator")

		// Apply event type filter if provided
		if typeFilter != "" {
			query = query.Where("event_type = ?", typeFilter)
		}

		if userRole == "admin" {
			// Admins can see all events
			query = query.Find(&events)
		} else {
			// Regular users and managers only see events they've joined.
			// We JOIN to event_players and filter by the current user's ID.
			query = query.
				Joins("JOIN event_players ON event_players.event_id = events.id").
				Where("event_players.user_id = ?", userID).
				Find(&events)
		}

		if query.Error != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": "failed to fetch events",
			})
		}

		// Build the response array, adding the member count for each event
		response := make([]EventResponse, 0, len(events))
		for _, event := range events {
			// Count how many event_players are in this event
			var memberCount int64
			db.Model(&models.EventPlayer{}).
				Where("event_id = ?", event.ID).
				Count(&memberCount)

			response = append(response, EventResponse{
				ID:          event.ID.String(),
				Name:        event.Name,
				Description: event.Description,
				EventType:   string(event.EventType),
				Status:      string(event.Status),
				StartDate:   formatOptionalDate(event.StartDate),
				EndDate:     formatOptionalDate(event.EndDate),
				// Creator was preloaded above — access the display name directly
				CreatorName: event.Creator.DisplayName,
				MemberCount: memberCount,
				// Format the timestamp as ISO 8601 for easy parsing in TypeScript
				CreatedAt: event.CreatedAt.UTC().Format(time.RFC3339),
			})
		}

		return c.JSON(response)
	}
}

// CreateEvent returns a handler for POST /api/v1/events.
// Requires "admin" or "manager" role (enforced by RequireRole middleware on the route).
// Creates the event record and automatically adds the creator as an organizer.
func CreateEvent(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Read the creator's internal UUID from the request context
		userIDStr, _ := c.Locals("userID").(string)
		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "invalid user ID",
			})
		}

		// Parse the JSON request body into our request struct.
		// c.BodyParser reads the body and unmarshals JSON fields that match struct tags.
		var req CreateEventRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "invalid request body",
			})
		}

		// Validate required fields
		if req.Name == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "name is required",
			})
		}

		// Validate event_type: must be one of the known values
		switch req.EventType {
		case "league", "tournament", "casual":
			// valid
		default:
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "event_type must be 'league', 'tournament', or 'casual'",
			})
		}

		// Parse optional date fields
		startDate, err := parseOptionalDate(req.StartDate)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "start_date must be in YYYY-MM-DD format",
			})
		}
		endDate, err := parseOptionalDate(req.EndDate)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "end_date must be in YYYY-MM-DD format",
			})
		}

		// --- Create the event record ---
		// We use a database transaction so that if the event_player insert fails,
		// the event itself is also rolled back — preventing orphaned event records.
		var createdEvent models.Event

		txErr := db.Transaction(func(tx *gorm.DB) error {
			// Build the Event struct — GORM will INSERT this row
			event := models.Event{
				Name:        req.Name,
				Description: req.Description,
				EventType:   models.EventType(req.EventType),
				// New events start as "active" — "upcoming" was removed from the status enum.
			Status:      models.EventStatusActive,
				StartDate:   startDate,
				EndDate:     endDate,
				CreatedBy:   userID, // Foreign key pointing to the creator's users.id
			}

			// tx.Create() runs an INSERT and populates event.ID with the new UUID
			if err := tx.Create(&event).Error; err != nil {
				return err // Returning an error causes the transaction to roll back
			}

			// --- Add the creator as an event organizer ---
			// Every event must have at least one organizer — the creator gets that role.
			// "organizer" role allows them to edit the event, invite members, and schedule rounds.
			player := models.EventPlayer{
				EventID: event.ID,
				UserID:  userID,
				Role:    models.EventPlayerRoleOrganizer, // creator = organizer
				Status:  models.EventPlayerStatusRegistered,
			}
			if err := tx.Create(&player).Error; err != nil {
				return err
			}

			// Store the created event so we can reference it outside the transaction
			createdEvent = event
			return nil // Returning nil commits the transaction
		})

		if txErr != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": "failed to create event",
			})
		}

		// Fetch the creator's display name for the response
		var creator models.User
		db.First(&creator, "id = ?", userID)

		// Return the newly created event with HTTP 201 Created
		return c.Status(fiber.StatusCreated).JSON(EventResponse{
			ID:          createdEvent.ID.String(),
			Name:        createdEvent.Name,
			Description: createdEvent.Description,
			EventType:   string(createdEvent.EventType),
			Status:      string(createdEvent.Status),
			StartDate:   formatOptionalDate(createdEvent.StartDate),
			EndDate:     formatOptionalDate(createdEvent.EndDate),
			CreatorName: creator.DisplayName,
			MemberCount: 1, // Just the creator so far
			CreatedAt:   createdEvent.CreatedAt.UTC().Format(time.RFC3339),
		})
	}
}

// isEventOrganizer reports whether a user has permission to manage a specific event.
//
// Two-tier permission model:
//   - Global "admin" role → can manage ANY event (platform-wide access).
//   - Everyone else (including global "manager") → must hold the "organizer"
//     event_player role for THIS specific event.
//
// Consequence for managers:
//   - A manager who creates an event is auto-added as its organizer → can manage it.
//   - A manager cannot manage another person's event unless that event's organizer
//     has explicitly added them as an organizer via event_players.
//
// Usage: call this at the start of any handler that modifies an event.
//
//	if !isEventOrganizer(db, eventID, userID, userRole) {
//	    return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
//	}
func isEventOrganizer(db *gorm.DB, eventID, userID uuid.UUID, userRole string) bool {
	// Global admins bypass all event-level checks
	if userRole == "admin" {
		return true
	}

	// All other roles (manager, user) must be explicitly an organizer of this event.
	// We look up their event_player row and check the role column.
	var player models.EventPlayer
	err := db.Where("event_id = ? AND user_id = ?", eventID, userID).First(&player).Error
	return err == nil && player.Role == models.EventPlayerRoleOrganizer
}

// --- Additional response / request types ---

// EventDetailResponse extends EventResponse with the full members list.
// Returned by GET /api/v1/events/:id so the mobile app can show the member
// roster and determine whether the current user is an organizer.
type EventDetailResponse struct {
	EventResponse                   // embed — all the list fields are included automatically
	Members       []MemberResponse `json:"members"` // everyone who belongs to this event
}

// MemberResponse describes a single event_player row with the user's display info.
type MemberResponse struct {
	UserID      string `json:"user_id"`      // Internal UUID (used as a key for remove operations)
	DisplayName string `json:"display_name"` // Human-readable name
	Email       string `json:"email"`        // Used by the mobile app to match against the Clerk user
	Role        string `json:"role"`         // "organizer" or "player"
	Status      string `json:"status"`       // "invited", "registered", "withdrawn", "completed"
	JoinedAt    string `json:"joined_at"`    // ISO 8601 timestamp
}

// UpdateEventRequest is the JSON body for PATCH /api/v1/events/:id.
// All fields are optional pointers — only non-nil fields are applied to the event.
// To clear an optional text field, send an empty string (the pointer itself must be non-nil).
type UpdateEventRequest struct {
	Name        *string `json:"name"`        // Optional new name; "" is rejected (name is required)
	Description *string `json:"description"` // Optional description; "" clears it
	StartDate   *string `json:"start_date"`  // Optional "YYYY-MM-DD"; "" clears it
	EndDate     *string `json:"end_date"`    // Optional "YYYY-MM-DD"; "" clears it
	// Status allows organizers to change the event lifecycle state.
	// Valid values: "upcoming", "active", "completed", "cancelled".
	Status      *string `json:"status"`
}

// AddMemberRequest is the JSON body for POST /api/v1/events/:id/members.
type AddMemberRequest struct {
	UserID string `json:"user_id"` // UUID of the user to add; must already exist in users table
}

// GroupInput describes one tee-time group to create along with a new round.
// Only the tee time is configurable at scheduling time; players are assigned later
// via the Round detail screen (POST /api/v1/rounds/:id/groups/:groupId/members).
type GroupInput struct {
	// TeeTime is optional. Accepted formats: "15:04" (24-hour, e.g. "07:30") or "3:04 PM".
	// If omitted or unparseable, the group is created with no scheduled tee time.
	TeeTime *string `json:"tee_time"`
}

// ScheduleRoundRequest is the JSON body for POST /api/v1/events/:id/rounds.
type ScheduleRoundRequest struct {
	// Name is the display name for the round. Optional — defaults to "Round N" where N is
	// the round number (1-based count of existing rounds + 1). Organizers can set a custom
	// name like "Championship Round" or "Back Nine Special".
	Name          string       `json:"name"`
	CourseName    string       `json:"course_name"`    // Required: name of the golf course
	ScheduledDate string       `json:"scheduled_date"` // Required: "YYYY-MM-DD"
	ScoringFormat *string      `json:"scoring_format"` // Optional; defaults to "stroke" if omitted
	// Groups lists the tee-time groups to create with this round (1–8).
	// An empty slice creates one default group with no tee time.
	Groups        []GroupInput `json:"groups"`
}

// RoundSummaryResponse is returned per round in the rounds list and on round creation.
type RoundSummaryResponse struct {
	ID            string `json:"id"`             // UUID string
	Name          string `json:"name"`           // Display name, e.g. "Round 1" or "Championship Round"
	CourseName    string `json:"course_name"`    // Name of the course
	ScheduledDate string `json:"scheduled_date"` // "YYYY-MM-DD"
	Status        string `json:"status"`         // "scheduled", "active", "completed"
	ScoringFormat string `json:"scoring_format"` // e.g. "stroke", "stableford"
	RoundNumber   int    `json:"round_number"`   // 1-based index within the event
	GroupCount    int    `json:"group_count"`    // Number of tee-time groups created for this round
}

// --- New handlers ---

// GetEvent returns a handler for GET /api/v1/events/:id.
// - Admins can fetch any event.
// - Other users can only fetch events they are a member of.
// Returns EventDetailResponse (includes the full members list).
func GetEvent(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		// Parse the event UUID from the URL parameter (:id)
		eventID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid event ID"})
		}

		// Load the event — Preload("Creator") fetches the related User row automatically
		var event models.Event
		if err := db.Preload("Creator").First(&event, "id = ?", eventID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "event not found"})
		}

		// Access check: non-admins may only view events they belong to
		if userRole != "admin" {
			var count int64
			db.Model(&models.EventPlayer{}).
				Where("event_id = ? AND user_id = ?", eventID, userID).
				Count(&count)
			if count == 0 {
				return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not a member of this event"})
			}
		}

		// Load all event_players, preloading the related User row for each one
		var players []models.EventPlayer
		db.Preload("User").Where("event_id = ?", eventID).Find(&players)

		// Build the members slice from the loaded players
		members := make([]MemberResponse, 0, len(players))
		for _, p := range players {
			members = append(members, MemberResponse{
				UserID:      p.UserID.String(),
				DisplayName: p.User.DisplayName,
				Email:       p.User.Email,
				Role:        string(p.Role),
				Status:      string(p.Status),
				JoinedAt:    p.CreatedAt.UTC().Format(time.RFC3339),
			})
		}

		return c.JSON(EventDetailResponse{
			EventResponse: EventResponse{
				ID:          event.ID.String(),
				Name:        event.Name,
				Description: event.Description,
				EventType:   string(event.EventType),
				Status:      string(event.Status),
				StartDate:   formatOptionalDate(event.StartDate),
				EndDate:     formatOptionalDate(event.EndDate),
				CreatorName: event.Creator.DisplayName,
				MemberCount: int64(len(players)),
				CreatedAt:   event.CreatedAt.UTC().Format(time.RFC3339),
			},
			Members: members,
		})
	}
}

// UpdateEvent returns a handler for PATCH /api/v1/events/:id.
// Only organizers of the event (or global admins) may update it.
// Only non-nil fields in the request body are applied — this is a partial update.
func UpdateEvent(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		eventID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid event ID"})
		}

		// Load the event with its creator so we can return the creator name in the response
		var event models.Event
		if err := db.Preload("Creator").First(&event, "id = ?", eventID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "event not found"})
		}

		// Only organizers (or global admins) can edit an event
		if !isEventOrganizer(db, eventID, userID, userRole) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		var req UpdateEventRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		// Apply only the fields that were explicitly included in the request (non-nil pointers)
		if req.Name != nil {
			if *req.Name == "" {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name cannot be empty"})
			}
			event.Name = *req.Name
		}
		if req.Description != nil {
			// Allow setting to empty string (clears the description)
			event.Description = req.Description
		}
		if req.StartDate != nil {
			t, err := parseOptionalDate(req.StartDate)
			if err != nil {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "start_date must be YYYY-MM-DD"})
			}
			event.StartDate = t
		}
		if req.EndDate != nil {
			t, err := parseOptionalDate(req.EndDate)
			if err != nil {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "end_date must be YYYY-MM-DD"})
			}
			event.EndDate = t
		}
		if req.Status != nil {
			// Validate against the three valid EventStatus values.
			// "upcoming" was removed — only "active", "completed", and "cancelled" are accepted.
			switch *req.Status {
			case "active", "completed", "cancelled":
				event.Status = models.EventStatus(*req.Status)
			default:
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
					"error": "status must be 'active', 'completed', or 'cancelled'",
				})
			}
		}

		// db.Save() runs an UPDATE for all columns (not just changed ones — GORM doesn't diff)
		if err := db.Save(&event).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update event"})
		}

		// Count current members for the response
		var memberCount int64
		db.Model(&models.EventPlayer{}).Where("event_id = ?", event.ID).Count(&memberCount)

		return c.JSON(EventResponse{
			ID:          event.ID.String(),
			Name:        event.Name,
			Description: event.Description,
			EventType:   string(event.EventType),
			Status:      string(event.Status),
			StartDate:   formatOptionalDate(event.StartDate),
			EndDate:     formatOptionalDate(event.EndDate),
			CreatorName: event.Creator.DisplayName,
			MemberCount: memberCount,
			CreatedAt:   event.CreatedAt.UTC().Format(time.RFC3339),
		})
	}
}

// GetEventMembers returns a handler for GET /api/v1/events/:id/members.
// Returns the full members list for the event. Any authenticated user who can
// see the event can also see its members list.
func GetEventMembers(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		eventID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid event ID"})
		}

		// Load all event_players, each with their associated user record
		var players []models.EventPlayer
		db.Preload("User").Where("event_id = ?", eventID).Find(&players)

		members := make([]MemberResponse, 0, len(players))
		for _, p := range players {
			members = append(members, MemberResponse{
				UserID:      p.UserID.String(),
				DisplayName: p.User.DisplayName,
				Email:       p.User.Email,
				Role:        string(p.Role),
				Status:      string(p.Status),
				JoinedAt:    p.CreatedAt.UTC().Format(time.RFC3339),
			})
		}
		return c.JSON(members)
	}
}

// AddEventMember returns a handler for POST /api/v1/events/:id/members.
// Requires the caller to be an organizer of the event.
// The added user receives the "player" role and "registered" status by default.
func AddEventMember(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		eventID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid event ID"})
		}

		if !isEventOrganizer(db, eventID, userID, userRole) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		var req AddMemberRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		targetUserID, err := uuid.Parse(req.UserID)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user_id"})
		}

		// Verify the target user actually exists in our system
		var targetUser models.User
		if err := db.First(&targetUser, "id = ?", targetUserID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user not found"})
		}

		// Prevent duplicate membership — the DB has a unique index on (event_id, user_id)
		// but we return a friendlier error than a constraint violation
		var existing models.EventPlayer
		if err := db.Where("event_id = ? AND user_id = ?", eventID, targetUserID).First(&existing).Error; err == nil {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "user is already a member"})
		}

		// Insert the new event_player row
		player := models.EventPlayer{
			EventID: eventID,
			UserID:  targetUserID,
			Role:    models.EventPlayerRolePlayer,      // default: participant
			Status:  models.EventPlayerStatusRegistered, // auto-confirmed when added by organizer
		}
		if err := db.Create(&player).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to add member"})
		}

		return c.Status(fiber.StatusCreated).JSON(MemberResponse{
			UserID:      targetUser.ID.String(),
			DisplayName: targetUser.DisplayName,
			Email:       targetUser.Email,
			Role:        string(player.Role),
			Status:      string(player.Status),
			JoinedAt:    player.CreatedAt.UTC().Format(time.RFC3339),
		})
	}
}

// RemoveEventMember returns a handler for DELETE /api/v1/events/:id/members/:userId.
// Requires the caller to be an organizer.
// Prevents removing the last organizer — every event must have at least one.
func RemoveEventMember(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		eventID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid event ID"})
		}

		targetUserID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID in path"})
		}

		if !isEventOrganizer(db, eventID, userID, userRole) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		// Find the event_player record to be removed
		var player models.EventPlayer
		if err := db.Where("event_id = ? AND user_id = ?", eventID, targetUserID).First(&player).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "member not found"})
		}

		// Guard: cannot remove the last organizer — the event would become unmanageable
		if player.Role == models.EventPlayerRoleOrganizer {
			var organizerCount int64
			db.Model(&models.EventPlayer{}).
				Where("event_id = ? AND role = ?", eventID, models.EventPlayerRoleOrganizer).
				Count(&organizerCount)
			if organizerCount <= 1 {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
					"error": "cannot remove the last organizer; promote another member first",
				})
			}
		}

		if err := db.Delete(&player).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to remove member"})
		}

		// 204 No Content — successful delete with no body
		return c.SendStatus(fiber.StatusNoContent)
	}
}

// GetEventRounds returns a handler for GET /api/v1/events/:id/rounds.
// Returns rounds sorted by round_number ascending (chronological order).
func GetEventRounds(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		eventID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid event ID"})
		}

		// Load all rounds for this event, with the Course name preloaded
		var rounds []models.Round
		db.Preload("Course").
			Where("event_id = ?", eventID).
			Order("round_number ASC").
			Find(&rounds)

		// Build a map of round_id → group count so we can include it in each summary row.
		// One query across all rounds is more efficient than N individual COUNT queries.
		roundIDs := make([]string, len(rounds))
		for i, r := range rounds {
			roundIDs[i] = r.ID.String()
		}

		// groupCountRows holds the (round_id, count) pairs returned by the aggregate query.
		type groupCountRow struct {
			RoundID string
			Count   int
		}
		var groupCountRows []groupCountRow
		if len(roundIDs) > 0 {
			db.Model(&models.Group{}).
				Select("round_id, COUNT(*) as count").
				Where("round_id IN ?", roundIDs).
				Group("round_id").
				Scan(&groupCountRows)
		}

		// Convert the slice into a map for O(1) lookup while building the response.
		groupCountMap := make(map[string]int, len(groupCountRows))
		for _, row := range groupCountRows {
			groupCountMap[row.RoundID] = row.Count
		}

		response := make([]RoundSummaryResponse, 0, len(rounds))
		for _, r := range rounds {
			response = append(response, RoundSummaryResponse{
				ID:            r.ID.String(),
				Name:          r.Name,
				CourseName:    r.Course.Name,
				ScheduledDate: r.ScheduledDate.UTC().Format("2006-01-02"),
				Status:        string(r.Status),
				ScoringFormat: string(r.ScoringFormat),
				RoundNumber:   r.RoundNumber,
				GroupCount:    groupCountMap[r.ID.String()],
			})
		}
		return c.JSON(response)
	}
}

// ScheduleEventRound returns a handler for POST /api/v1/events/:id/rounds.
// Requires organizer permission.
//
// Course handling:
//   - Looks for an existing course by name (case-insensitive).
//   - If none found, creates a new Course + a "Default" Tee with standard par-72 ratings.
//   - If found but has no tees, creates the default Tee on the existing course.
//
// Round number is determined automatically: COUNT(existing rounds) + 1.
func ScheduleEventRound(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		eventID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid event ID"})
		}

		if !isEventOrganizer(db, eventID, userID, userRole) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		var req ScheduleRoundRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		if req.CourseName == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "course_name is required"})
		}
		if req.ScheduledDate == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "scheduled_date is required"})
		}

		scheduledDate, err := time.Parse("2006-01-02", req.ScheduledDate)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "scheduled_date must be YYYY-MM-DD"})
		}

		// Default scoring format is stroke play if the caller didn't specify one
		scoringFormat := models.ScoringFormatStroke
		if req.ScoringFormat != nil && *req.ScoringFormat != "" {
			scoringFormat = models.ScoringFormat(*req.ScoringFormat)
		}

		// We run everything inside a transaction so that partial failures
		// (e.g. course created but round insert fails) are cleanly rolled back.
		var createdRound models.Round
		var courseName string
		// groupInputs is resolved before the transaction so we know the final count
		// for the response even if the caller sent an empty slice.
		groupInputs := req.Groups
		if len(groupInputs) == 0 {
			// Default: always create at least one group so the round has a roster structure.
			groupInputs = []GroupInput{{}}
		}

		txErr := db.Transaction(func(tx *gorm.DB) error {
			// --- Find or create the course ---
			// ILIKE is PostgreSQL's case-insensitive LIKE — matches "Pine Valley" and "pine valley"
			var course models.Course
			courseErr := tx.Where("name ILIKE ?", req.CourseName).First(&course).Error

			var teeID uuid.UUID

			if courseErr != nil {
				// Course not found — create it with sensible defaults.
				// City/State are left blank; HoleCount defaults to 18.
				course = models.Course{
					Name:      req.CourseName,
					HoleCount: 18,
				}
				if err := tx.Create(&course).Error; err != nil {
					return err
				}

				// Create a default tee. Values represent an average par-72 course:
				//   CourseRating 72.0 = a scratch golfer is expected to shoot 72
				//   SlopeRating 113   = USGA baseline; average difficulty for bogey golfers
				defaultTee := models.Tee{
					CourseID:     course.ID,
					Name:         "Default",
					Gender:       models.TeeGenderUnisex,
					CourseRating: 72.0,
					SlopeRating:  113,
					Par:          72,
				}
				if err := tx.Create(&defaultTee).Error; err != nil {
					return err
				}
				teeID = defaultTee.ID
			} else {
				// Course exists — load its first tee.
				var tee models.Tee
				teeErr := tx.Where("course_id = ?", course.ID).First(&tee).Error
				if teeErr != nil {
					// Course exists but somehow has no tees — create the default tee
					tee = models.Tee{
						CourseID:     course.ID,
						Name:         "Default",
						Gender:       models.TeeGenderUnisex,
						CourseRating: 72.0,
						SlopeRating:  113,
						Par:          72,
					}
					if err := tx.Create(&tee).Error; err != nil {
						return err
					}
				}
				teeID = tee.ID
			}

			courseName = course.Name

			// --- Determine the next round number ---
			// COUNT all existing rounds for this event, then add 1
			var roundCount int64
			tx.Model(&models.Round{}).Where("event_id = ?", eventID).Count(&roundCount)
			nextRoundNumber := int(roundCount) + 1

			// --- Determine the round name ---
			// Use the name from the request if provided; otherwise default to "Round N".
			// fmt.Sprintf formats "Round 1", "Round 2", etc. as a sensible default.
			roundName := req.Name
			if roundName == "" {
				roundName = fmt.Sprintf("Round %d", nextRoundNumber)
			}

			// --- Create the round ---
			createdRound = models.Round{
				EventID:          eventID,
				CourseID:         course.ID,
				DefaultTeeID:     teeID,
				Name:             roundName,
				RoundNumber:      nextRoundNumber,
				ScheduledDate:    scheduledDate,
				Status:           models.RoundStatusScheduled,
				ScoringFormat:    scoringFormat,
				RequiresHandicap: false,
			}
			if err := tx.Create(&createdRound).Error; err != nil {
				return err
			}

			// --- Create tee-time groups ---
			// Groups are created atomically with the round. Players are assigned later via
			// POST /api/v1/rounds/:id/groups/:groupId/members.
			for i, g := range groupInputs {
				group := models.Group{
					RoundID:      createdRound.ID,
					GroupNumber:  i + 1,
					StartingHole: 1, // default; shotgun starts can be configured later
				}

				// Parse optional tee time. We try 24-hour "15:04" first (e.g. "07:30"),
				// then 12-hour "3:04 PM" as a fallback (e.g. "7:30 AM").
				// If neither matches, TeeTime stays nil — no error raised.
				if g.TeeTime != nil && *g.TeeTime != "" {
					var parsedTime time.Time
					var parseErr error
					parsedTime, parseErr = time.Parse("15:04", *g.TeeTime)
					if parseErr != nil {
						parsedTime, parseErr = time.Parse("3:04 PM", *g.TeeTime)
					}
					if parseErr == nil {
						// Combine the round's scheduled date with the parsed hours/minutes
						// to produce a full TIMESTAMPTZ value for storage.
						teeTime := time.Date(
							scheduledDate.Year(), scheduledDate.Month(), scheduledDate.Day(),
							parsedTime.Hour(), parsedTime.Minute(), 0, 0, time.UTC,
						)
						group.TeeTime = &teeTime
					}
				}

				if err := tx.Create(&group).Error; err != nil {
					return err
				}
			}

			return nil
		})

		if txErr != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to schedule round"})
		}

		return c.Status(fiber.StatusCreated).JSON(RoundSummaryResponse{
			ID:            createdRound.ID.String(),
			Name:          createdRound.Name,
			CourseName:    courseName,
			ScheduledDate: createdRound.ScheduledDate.UTC().Format("2006-01-02"),
			Status:        string(createdRound.Status),
			ScoringFormat: string(createdRound.ScoringFormat),
			RoundNumber:   createdRound.RoundNumber,
			GroupCount:    len(groupInputs),
		})
	}
}

// DeleteEvent returns a handler for DELETE /api/v1/events/:id.
// Permanently deletes the event and all its associated data (rounds, members, scores).
// The cascade deletions are handled by the database's ON DELETE CASCADE constraints:
//   events → event_players, event_points_rules, rounds
//   rounds → round_players, groups, teams, scores (and their children)
// Only organizers of the event (or global admins) may delete it.
func DeleteEvent(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		eventID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid event ID"})
		}

		// Load the event first so we have a concrete record to delete
		var event models.Event
		if err := db.First(&event, "id = ?", eventID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "event not found"})
		}

		// Only the event's organizer (or a global admin) may delete it
		if !isEventOrganizer(db, eventID, userID, userRole) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		// db.Delete() runs a soft delete by default if the model has DeletedAt.
		// Our Event model doesn't have a DeletedAt field, so this is a hard DELETE.
		// The database's ON DELETE CASCADE constraints remove all child records automatically.
		if err := db.Delete(&event).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to delete event"})
		}

		// 204 No Content — success with no response body
		return c.SendStatus(fiber.StatusNoContent)
	}
}
