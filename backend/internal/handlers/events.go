// Package handlers contains HTTP route handler functions for the Golf League API.
// This file handles all /api/v1/events routes:
//
//	GET    /events                        — list events (filtered by membership)
//	POST   /events                        — create a new event
//	GET    /events/:id                    — get event detail + members list
//	PATCH  /events/:id                    — update event name/description/dates/status
//	GET    /events/:id/members            — list all members of an event
//	POST   /events/:id/members            — add a member to an event
//	DELETE /events/:id/members/:userId    — remove a member from an event
//	GET    /events/:id/rounds             — list rounds for an event
//	POST   /events/:id/rounds             — schedule a new round
//
// An "event" is the top-level container for any golf competition:
//   - "league"     — ongoing, multi-round season with accumulated standings
//   - "tournament" — one-off competitive event (1 or more rounds)
//   - "casual"     — informal round; no standings, no points
//
// Each exported function follows the "handler factory" pattern: it accepts a *gorm.DB
// and returns a fiber.Handler, injecting the database without global variables.
//
// Permission model — two layers:
//  1. Route-level (middleware.RequireRole): who can call the route at all.
//  2. Resource-level (isEventOrganizer): who can modify a specific event.
//     - "admin" global role → can manage ANY event.
//     - "manager" / "user" → only events where they hold the "organizer" event_player role.
package handlers

import (
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/observability"
	"gorm.io/gorm"
)

// EventResponse is what we send back to the mobile app.
// We use a dedicated response struct so we control exactly what gets serialised
// and can include computed fields like MemberCount.
type EventResponse struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	EventType   string  `json:"event_type"`
	Status      string  `json:"status"`
	StartDate   *string `json:"start_date"`
	EndDate     *string `json:"end_date"`
	CreatorName string  `json:"creator_name"`
	MemberCount int64   `json:"member_count"`
	CreatedAt   string  `json:"created_at"`
}

// CreateEventRequest is the JSON body we expect on POST /api/v1/events.
type CreateEventRequest struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
	EventType   string  `json:"event_type"` // "league", "tournament", or "casual"
	StartDate   *string `json:"start_date"` // optional "YYYY-MM-DD"
	EndDate     *string `json:"end_date"`   // optional "YYYY-MM-DD"
}

// formatOptionalDate converts a *time.Time to a *string in "2006-01-02" format.
// Returns nil if the input is nil.
func formatOptionalDate(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format("2006-01-02")
	return &s
}

// parseOptionalDate parses an optional "YYYY-MM-DD" string into a *time.Time.
// Returns nil if the input is nil or empty; returns an error for invalid dates.
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
// Admins see all events; everyone else sees only events they are an event_player of.
// Optional query param: ?type=league|tournament|casual
func GetEvents(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)

		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "invalid user ID",
			})
		}

		typeFilter := c.Query("type")

		// Preload("Creator") fetches the related User row to avoid N+1 queries.
		var events []models.Event
		query := db.Preload("Creator")

		if typeFilter != "" {
			query = query.Where("event_type = ?", typeFilter)
		}

		if userRole == "admin" {
			query = query.Find(&events)
		} else {
			// Non-admins only see events they've joined via event_players.
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

		response := make([]EventResponse, 0, len(events))
		for _, event := range events {
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
				CreatorName: event.Creator.DisplayName,
				MemberCount: memberCount,
				CreatedAt:   event.CreatedAt.UTC().Format(time.RFC3339),
			})
		}

		return c.JSON(response)
	}
}

// CreateEvent returns a handler for POST /api/v1/events.
// Requires "admin" or "manager" role (enforced by RequireRole middleware on the route).
// Creates the event and automatically adds the creator as an organizer in one transaction.
func CreateEvent(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"error": "invalid user ID",
			})
		}

		var req CreateEventRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "invalid request body",
			})
		}

		if req.Name == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "name is required",
			})
		}

		switch req.EventType {
		case "league", "tournament", "casual":
			// valid
		default:
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
				"error": "event_type must be 'league', 'tournament', or 'casual'",
			})
		}

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

		// Use a transaction so that if the event_player insert fails, the event is also
		// rolled back — preventing orphaned event records.
		var createdEvent models.Event

		txErr := db.Transaction(func(tx *gorm.DB) error {
			event := models.Event{
				Name:        req.Name,
				Description: req.Description,
				EventType:   models.EventType(req.EventType),
				// New events start as "active" — "upcoming" was removed from the status enum.
				Status:    models.EventStatusActive,
				StartDate: startDate,
				EndDate:   endDate,
				CreatedBy: userID,
			}

			if err := tx.Create(&event).Error; err != nil {
				return err
			}

			// Auto-add the creator as an organizer so they can manage the event immediately.
			player := models.EventPlayer{
				EventID: event.ID,
				UserID:  userID,
				Role:    models.EventPlayerRoleOrganizer,
				Status:  models.EventPlayerStatusRegistered,
			}
			if err := tx.Create(&player).Error; err != nil {
				return err
			}

			createdEvent = event
			return nil
		})

		if txErr != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
				"error": "failed to create event",
			})
		}

		observability.LogInfo(c.UserContext(), "event.created", "Event created",
			"event_id", createdEvent.ID.String(),
			"event_type", string(createdEvent.EventType),
			"user_id", userID.String(),
		)

		var creator models.User
		db.First(&creator, "id = ?", userID)

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
//   - Global "admin" → can manage ANY event.
//   - Everyone else (including global "manager") → must hold the "organizer"
//     event_player role for THIS specific event.
//
// Call this at the start of any handler that modifies an event.
func isEventOrganizer(db *gorm.DB, eventID, userID uuid.UUID, userRole string) bool {
	if userRole == "admin" {
		return true
	}

	var player models.EventPlayer
	err := db.Where("event_id = ? AND user_id = ?", eventID, userID).First(&player).Error
	return err == nil && player.Role == models.EventPlayerRoleOrganizer
}

// EventDetailResponse extends EventResponse with the full members list.
// Returned by GET /api/v1/events/:id.
type EventDetailResponse struct {
	EventResponse
	Members []MemberResponse `json:"members"`
}

// MemberResponse describes a single event_player row with the user's display info.
type MemberResponse struct {
	UserID      string  `json:"user_id"`
	DisplayName string  `json:"display_name"`
	Email       string  `json:"email"`
	AvatarURL   *string `json:"avatar_url"`
	Role        string  `json:"role"`   // "organizer" or "player"
	Status      string  `json:"status"` // "invited", "registered", "withdrawn", "completed"
	JoinedAt    string  `json:"joined_at"`
}

// UpdateEventRequest is the JSON body for PATCH /api/v1/events/:id.
// All fields are optional pointers — only non-nil fields are applied (partial update).
// "upcoming" was removed — valid status values are "active", "completed", "cancelled".
type UpdateEventRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	StartDate   *string `json:"start_date"` // "YYYY-MM-DD"; "" clears it
	EndDate     *string `json:"end_date"`   // "YYYY-MM-DD"; "" clears it
	Status      *string `json:"status"`
}

// AddMemberRequest is the JSON body for POST /api/v1/events/:id/members.
type AddMemberRequest struct {
	UserID string `json:"user_id"` // UUID of the user to add
}

// GroupInput describes one tee-time group to create along with a new round.
// Players are assigned later via POST /rounds/:id/groups/:groupId/members.
type GroupInput struct {
	// TeeTime accepts "15:04" (24-hour) or "3:04 PM". Unparseable values are silently ignored.
	TeeTime *string `json:"tee_time"`
}

// ScheduleRoundRequest is the JSON body for POST /api/v1/events/:id/rounds.
type ScheduleRoundRequest struct {
	// Name defaults to "Round N" (1-based count of existing rounds + 1) if omitted.
	Name          string  `json:"name"`
	ScheduledDate string  `json:"scheduled_date"` // required "YYYY-MM-DD"
	ScoringFormat *string `json:"scoring_format"` // defaults to "stroke" if omitted
	// Groups lists tee-time groups (1–8). An empty slice creates one default group.
	Groups []GroupInput `json:"groups"`

	// Preferred: select a pre-managed course by UUID.
	// When course_id is set, default_tee_id is also required.
	CourseID     *string `json:"course_id"`      // UUID of an existing course
	DefaultTeeID *string `json:"default_tee_id"` // UUID of a tee set on that course

	// Legacy fallback: find-or-create by name. Used only when course_id is absent.
	// Prefer course_id — this field will be removed in a future version.
	CourseName string `json:"course_name"`

	// NineHoleSelection restricts play to 9 holes on an 18-hole course.
	// "front" = holes 1–9, "back" = holes 10–18. Omit (or null) for a full round.
	// Invalid on 9-hole courses — the backend returns 400 in that case.
	NineHoleSelection *string `json:"nine_hole_selection"`
}

// RoundSummaryResponse is returned per round in the rounds list and on round creation.
type RoundSummaryResponse struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	CourseName    string `json:"course_name"`
	ScheduledDate string `json:"scheduled_date"`
	Status        string `json:"status"`
	ScoringFormat string `json:"scoring_format"`
	RoundNumber   int    `json:"round_number"`
	GroupCount    int    `json:"group_count"`
}

// GetEvent returns a handler for GET /api/v1/events/:id.
// Non-admins can only fetch events they are a member of.
// Returns EventDetailResponse (includes the full members list).
func GetEvent(db *gorm.DB) fiber.Handler {
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

		var event models.Event
		if err := db.Preload("Creator").First(&event, "id = ?", eventID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "event not found"})
		}

		if userRole != "admin" {
			var count int64
			db.Model(&models.EventPlayer{}).
				Where("event_id = ? AND user_id = ?", eventID, userID).
				Count(&count)
			if count == 0 {
				return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not a member of this event"})
			}
		}

		var players []models.EventPlayer
		db.Preload("User").Where("event_id = ?", eventID).Find(&players)

		members := make([]MemberResponse, 0, len(players))
		for _, p := range players {
			members = append(members, MemberResponse{
				UserID:      p.UserID.String(),
				DisplayName: p.User.DisplayName,
				Email:       p.User.Email,
				AvatarURL:   p.User.AvatarURL,
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
// Only non-nil fields are applied — partial update pattern.
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

		var event models.Event
		if err := db.Preload("Creator").First(&event, "id = ?", eventID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "event not found"})
		}

		if !isEventOrganizer(db, eventID, userID, userRole) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		var req UpdateEventRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		if req.Name != nil {
			if *req.Name == "" {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name cannot be empty"})
			}
			event.Name = *req.Name
		}
		if req.Description != nil {
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
			// "upcoming" was removed — only these three values are accepted.
			switch *req.Status {
			case "active", "completed", "cancelled":
				event.Status = models.EventStatus(*req.Status)
			default:
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
					"error": "status must be 'active', 'completed', or 'cancelled'",
				})
			}
		}

		// db.Save() issues an UPDATE for all columns (GORM doesn't diff).
		if err := db.Save(&event).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update event"})
		}

		if req.Status != nil {
			observability.LogInfo(c.UserContext(), "event.status_changed", "Event status changed",
				"event_id", event.ID.String(),
				"status", string(event.Status),
			)
		}

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
// Any authenticated user who can see the event can see its members list.
func GetEventMembers(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		eventID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid event ID"})
		}

		var players []models.EventPlayer
		db.Preload("User").Where("event_id = ?", eventID).Find(&players)

		members := make([]MemberResponse, 0, len(players))
		for _, p := range players {
			members = append(members, MemberResponse{
				UserID:      p.UserID.String(),
				DisplayName: p.User.DisplayName,
				Email:       p.User.Email,
				AvatarURL:   p.User.AvatarURL,
				Role:        string(p.Role),
				Status:      string(p.Status),
				JoinedAt:    p.CreatedAt.UTC().Format(time.RFC3339),
			})
		}
		return c.JSON(members)
	}
}

// AddEventMember returns a handler for POST /api/v1/events/:id/members.
// Requires the caller to be an organizer. New members receive the "player" role
// and "registered" status by default.
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

		var targetUser models.User
		if err := db.First(&targetUser, "id = ?", targetUserID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user not found"})
		}

		// Friendly duplicate check — the DB has a unique index on (event_id, user_id) too.
		var existing models.EventPlayer
		if err := db.Where("event_id = ? AND user_id = ?", eventID, targetUserID).First(&existing).Error; err == nil {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "user is already a member"})
		}

		player := models.EventPlayer{
			EventID: eventID,
			UserID:  targetUserID,
			Role:    models.EventPlayerRolePlayer,
			Status:  models.EventPlayerStatusRegistered,
		}
		if err := db.Create(&player).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to add member"})
		}

		return c.Status(fiber.StatusCreated).JSON(MemberResponse{
			UserID:      targetUser.ID.String(),
			DisplayName: targetUser.DisplayName,
			Email:       targetUser.Email,
			AvatarURL:   targetUser.AvatarURL,
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

		var player models.EventPlayer
		if err := db.Where("event_id = ? AND user_id = ?", eventID, targetUserID).First(&player).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "member not found"})
		}

		// Guard: removing the last organizer would leave the event unmanageable.
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

		return c.SendStatus(fiber.StatusNoContent)
	}
}

// GetEventRounds returns a handler for GET /api/v1/events/:id/rounds.
// Returns rounds sorted by round_number ascending.
func GetEventRounds(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		eventID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid event ID"})
		}

		var rounds []models.Round
		db.Preload("Course").
			Where("event_id = ?", eventID).
			Order("round_number ASC").
			Find(&rounds)

		// Fetch group counts in one query rather than N individual COUNTs.
		roundIDs := make([]string, len(rounds))
		for i, r := range rounds {
			roundIDs[i] = r.ID.String()
		}

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
//   - Looks for an existing course by name (case-insensitive via ILIKE).
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
		if req.CourseID == nil && req.CourseName == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "course_id or course_name is required"})
		}
		if req.CourseID != nil && req.DefaultTeeID == nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "default_tee_id is required when course_id is provided"})
		}
		if req.ScheduledDate == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "scheduled_date is required"})
		}

		scheduledDate, err := time.Parse("2006-01-02", req.ScheduledDate)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "scheduled_date must be YYYY-MM-DD"})
		}

		scoringFormat := models.ScoringFormatStroke
		if req.ScoringFormat != nil && *req.ScoringFormat != "" {
			scoringFormat = models.ScoringFormat(*req.ScoringFormat)
		}

		// Validate nine_hole_selection value before hitting the DB.
		// The course hole-count check (requires 18-hole course) happens inside the
		// transaction once the course record is loaded — that path is DB-dependent (Tier 2).
		if req.NineHoleSelection != nil {
			sel := *req.NineHoleSelection
			if sel != "front" && sel != "back" {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "nine_hole_selection must be \"front\" or \"back\""})
			}
		}

		var createdRound models.Round
		var courseName string
		groupInputs := req.Groups
		if len(groupInputs) == 0 {
			// Always create at least one group so the round has a roster structure.
			groupInputs = []GroupInput{{}}
		}

		txErr := db.Transaction(func(tx *gorm.DB) error {
			var course models.Course
			var teeID uuid.UUID

			if req.CourseID != nil {
				// Preferred path: use a pre-managed course selected by UUID.
				courseUUID, err := uuid.Parse(*req.CourseID)
				if err != nil {
					return fiber.NewError(fiber.StatusBadRequest, "invalid course_id")
				}
				if err := tx.First(&course, "id = ?", courseUUID).Error; err != nil {
					return fiber.NewError(fiber.StatusNotFound, "course not found")
				}
				teeUUID, err := uuid.Parse(*req.DefaultTeeID)
				if err != nil {
					return fiber.NewError(fiber.StatusBadRequest, "invalid default_tee_id")
				}
				var tee models.Tee
				if err := tx.First(&tee, "id = ? AND course_id = ?", teeUUID, courseUUID).Error; err != nil {
					return fiber.NewError(fiber.StatusNotFound, "tee not found for this course")
				}
				teeID = teeUUID
			} else {
				// Legacy fallback: find-or-create by name (ILIKE = case-insensitive match).
				courseErr := tx.Where("name ILIKE ?", req.CourseName).First(&course).Error
				if courseErr != nil {
					course = models.Course{Name: req.CourseName, HoleCount: 18}
					if err := tx.Create(&course).Error; err != nil {
						return err
					}
					// Default tee: CourseRating 72.0 and SlopeRating 113 are USGA baseline values.
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
					var tee models.Tee
					teeErr := tx.Where("course_id = ?", course.ID).First(&tee).Error
					if teeErr != nil {
						// Course exists but has no tees — create the default.
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
			}

			courseName = course.Name

			// Nine-hole selection is only valid for 18-hole courses.
			if req.NineHoleSelection != nil && course.HoleCount != 18 {
				return fiber.NewError(fiber.StatusBadRequest, "nine_hole_selection is only valid for 18-hole courses")
			}

			var roundCount int64
			tx.Model(&models.Round{}).Where("event_id = ?", eventID).Count(&roundCount)
			nextRoundNumber := int(roundCount) + 1

			roundName := req.Name
			if roundName == "" {
				roundName = fmt.Sprintf("Round %d", nextRoundNumber)
			}

			createdRound = models.Round{
				EventID:           eventID,
				CourseID:          course.ID,
				DefaultTeeID:      teeID,
				Name:              roundName,
				RoundNumber:       nextRoundNumber,
				ScheduledDate:     scheduledDate,
				Status:            models.RoundStatusScheduled,
				ScoringFormat:     scoringFormat,
				RequiresHandicap:  false,
				NineHoleSelection: req.NineHoleSelection,
			}
			if err := tx.Create(&createdRound).Error; err != nil {
				return err
			}

			for i, g := range groupInputs {
				group := models.Group{
					RoundID:      createdRound.ID,
					GroupNumber:  i + 1,
					StartingHole: 1,
				}

				// Try 24-hour "15:04" first, then 12-hour "3:04 PM" as fallback.
				// If neither matches, TeeTime stays nil — no error raised.
				if g.TeeTime != nil && *g.TeeTime != "" {
					var parsedTime time.Time
					var parseErr error
					parsedTime, parseErr = time.Parse("15:04", *g.TeeTime)
					if parseErr != nil {
						parsedTime, parseErr = time.Parse("3:04 PM", *g.TeeTime)
					}
					if parseErr == nil {
						// Combine the round's scheduled date with the parsed hours/minutes.
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
			// fiber.NewError() errors carry an HTTP status (e.g. 400, 404) from validation
			// inside the transaction. Pass those through; all other errors are 500.
			if fe, ok := txErr.(*fiber.Error); ok {
				return c.Status(fe.Code).JSON(fiber.Map{"error": fe.Message})
			}
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to schedule round"})
		}

		observability.LogInfo(c.UserContext(), "round.created", "Round scheduled",
			"round_id", createdRound.ID.String(),
			"event_id", eventID.String(),
		)

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
// Permanently deletes the event and all its associated data via ON DELETE CASCADE.
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

		var event models.Event
		if err := db.First(&event, "id = ?", eventID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "event not found"})
		}

		if !isEventOrganizer(db, eventID, userID, userRole) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		// Our Event model has no DeletedAt field, so this is a hard DELETE.
		// ON DELETE CASCADE removes all child records automatically.
		if err := db.Delete(&event).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to delete event"})
		}

		return c.SendStatus(fiber.StatusNoContent)
	}
}
