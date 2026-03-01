// Package handlers contains HTTP route handler functions for the Golf League API.
// This file handles the /api/v1/events routes — listing and creating events.
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
				Status:      models.EventStatusUpcoming,
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
