// Package handlers contains HTTP route handler functions for the Golf League API.
// This file handles all /api/v1/events routes:
//
//	GET    /events                        — list events (filtered by membership)
//	POST   /events                        — create a new event
//	GET    /events/:id                    — event detail + members list
//	PATCH  /events/:id                    — update event name/description/dates/status
//	DELETE /events/:id                    — delete an event (cascades)
//	GET    /events/:id/members            — list event members
//	POST   /events/:id/members            — add a member
//	DELETE /events/:id/members/:userId    — remove a member
//	GET    /events/:id/rounds             — list rounds for an event
//	POST   /events/:id/rounds             — schedule a new round (kept here pending PR #3)
//
// All business logic lives in internal/services.EventService. Each handler
// here parses HTTP input (URL params, JSON body, content-type), calls the
// service, and translates (value, error) into HTTP status + JSON via
// writeEventError, which also records error_detail on every 5xx so causes
// flow into Loki.
package handlers

import (
	"errors"
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/observability"
	"github.com/trentd187/golf-league/internal/services"
	"gorm.io/gorm"
)

// ─── Response types ────────────────────────────────────────────────────────────

// EventResponse is the JSON shape returned for individual events and list rows.
type EventResponse struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Description       *string  `json:"description"`
	EventType         string   `json:"event_type"`
	Status            string   `json:"status"`
	StartDate         *string  `json:"start_date"`
	EndDate           *string  `json:"end_date"`
	HandicapAllowance *float64 `json:"handicap_allowance"`
	CreatorName       string   `json:"creator_name"`
	MemberCount       int64    `json:"member_count"`
	CreatedAt         string   `json:"created_at"`
}

// EventDetailResponse extends EventResponse with the full members list.
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
	Role        string  `json:"role"`
	Status      string  `json:"status"`
	JoinedAt    string  `json:"joined_at"`
}

// RoundSummaryResponse is one row in the rounds-for-event list.
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

// ─── Request types ─────────────────────────────────────────────────────────────

// CreateEventRequest is the body for POST /api/v1/events.
type CreateEventRequest struct {
	Name              string   `json:"name"`
	Description       *string  `json:"description"`
	EventType         string   `json:"event_type"`
	StartDate         *string  `json:"start_date"`
	EndDate           *string  `json:"end_date"`
	HandicapAllowance *float64 `json:"handicap_allowance"`
}

// UpdateEventRequest is the body for PATCH /api/v1/events/:id.
// All fields are optional pointers — only present fields are applied.
type UpdateEventRequest struct {
	Name              *string  `json:"name"`
	Description       *string  `json:"description"`
	StartDate         *string  `json:"start_date"`
	EndDate           *string  `json:"end_date"`
	Status            *string  `json:"status"`
	HandicapAllowance *float64 `json:"handicap_allowance"`
}

// AddMemberRequest is the body for POST /api/v1/events/:id/members.
type AddMemberRequest struct {
	UserID string `json:"user_id"`
}

// GroupInput describes one tee-time group passed to ScheduleEventRound.
// Players are assigned later via POST /rounds/:id/groups/:groupId/members.
type GroupInput struct {
	// TeeTime accepts "15:04" (24-hour) or "3:04 PM". Unparseable values are silently ignored.
	TeeTime *string `json:"tee_time"`
}

// ScheduleRoundRequest is the body for POST /api/v1/events/:id/rounds.
type ScheduleRoundRequest struct {
	Name              string       `json:"name"`
	ScheduledDate     string       `json:"scheduled_date"`
	ScoringFormat     *string      `json:"scoring_format"`
	Groups            []GroupInput `json:"groups"`
	CourseID          *string      `json:"course_id"`
	DefaultTeeID      *string      `json:"default_tee_id"`
	CourseName        string       `json:"course_name"`
	NineHoleSelection *string      `json:"nine_hole_selection"`
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

// formatOptionalDate converts a *time.Time to a *string in "YYYY-MM-DD" format.
func formatOptionalDate(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format("2006-01-02")
	return &s
}

// authUser pulls the requesting user's UUID + role out of c.Locals (set by the
// auth middleware). Returns false on error and writes a 401; the caller should
// `return nil`.
func authUser(c *fiber.Ctx) (uuid.UUID, string, bool) {
	userIDStr, _ := c.Locals("userID").(string)
	userRole, _ := c.Locals("userRole").(string)
	userID, err := uuid.Parse(userIDStr)
	if err != nil {
		_ = c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		return uuid.Nil, "", false
	}
	return userID, userRole, true
}

// parseEventID parses ":id" as a UUID. Writes 400 + returns false on failure.
func parseEventID(c *fiber.Ctx) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		_ = c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid event ID"})
		return uuid.Nil, false
	}
	return id, true
}

// writeEventError translates a service error into HTTP status + JSON body.
// For every 5xx it sets c.Locals("error_detail", "<tag>: <cause>") so the
// HTTPMetrics middleware emits the cause in the Loki http.error log line.
//
// Always returns nil — handlers do `return writeEventError(c, err, ...)`.
func writeEventError(c *fiber.Ctx, err error, tag, fallbackMsg string) error {
	var ve *services.ValidationError
	if errors.As(err, &ve) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": ve.Message})
	}
	switch {
	case errors.Is(err, services.ErrEventNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "event not found"})
	case errors.Is(err, services.ErrUserNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user not found"})
	case errors.Is(err, services.ErrMemberNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "member not found"})
	case errors.Is(err, services.ErrEventForbidden):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
	case errors.Is(err, services.ErrEventNotMember):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not a member of this event"})
	case errors.Is(err, services.ErrMemberAlreadyExists):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "user is already a member"})
	case errors.Is(err, services.ErrLastOrganizer):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"error": "cannot remove the last organizer; promote another member first",
		})
	}
	c.Locals("error_detail", tag+": "+err.Error())
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": fallbackMsg})
}

// buildEventResponse converts a service-layer EventListItem into the JSON shape.
func buildEventResponse(item services.EventListItem) EventResponse {
	return EventResponse{
		ID:                item.Event.ID.String(),
		Name:              item.Event.Name,
		Description:       item.Event.Description,
		EventType:         string(item.Event.EventType),
		Status:            string(item.Event.Status),
		StartDate:         formatOptionalDate(item.Event.StartDate),
		EndDate:           formatOptionalDate(item.Event.EndDate),
		HandicapAllowance: item.Event.HandicapAllowance,
		CreatorName:       item.Creator.DisplayName,
		MemberCount:       item.MemberCount,
		CreatedAt:         item.Event.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func buildMemberResponse(m services.EventMemberItem) MemberResponse {
	return MemberResponse{
		UserID:      m.User.ID.String(),
		DisplayName: m.User.DisplayName,
		Email:       m.User.Email,
		AvatarURL:   m.User.AvatarURL,
		Role:        string(m.Player.Role),
		Status:      string(m.Player.Status),
		JoinedAt:    m.Player.CreatedAt.UTC().Format(time.RFC3339),
	}
}

// ─── Handlers ──────────────────────────────────────────────────────────────────

// GetEvents returns a handler for GET /api/v1/events.
func GetEvents(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}
		items, err := svc.List(c.UserContext(), services.ListEventsFilters{
			UserID:   userID,
			UserRole: userRole,
			Type:     c.Query("type"),
		})
		if err != nil {
			return writeEventError(c, err, "event.list", "failed to fetch events")
		}
		out := make([]EventResponse, 0, len(items))
		for _, item := range items {
			out = append(out, buildEventResponse(item))
		}
		return c.JSON(out)
	}
}

// CreateEvent returns a handler for POST /api/v1/events.
// Any authenticated user may create an event; they are auto-added as the organizer.
func CreateEvent(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, _, ok := authUser(c)
		if !ok {
			return nil
		}
		var req CreateEventRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		item, err := svc.Create(c.UserContext(), services.CreateEventInput{
			Name:              req.Name,
			Description:       req.Description,
			EventType:         req.EventType,
			StartDate:         req.StartDate,
			EndDate:           req.EndDate,
			HandicapAllowance: req.HandicapAllowance,
			CreatedBy:         userID,
		})
		if err != nil {
			return writeEventError(c, err, "event.create", "failed to create event")
		}
		observability.LogInfo(c.UserContext(), "event.created", "Event created",
			"event_id", item.Event.ID.String(),
			"event_type", string(item.Event.EventType),
			"user_id", userID.String(),
		)
		return c.Status(fiber.StatusCreated).JSON(buildEventResponse(item))
	}
}

// GetEvent returns a handler for GET /api/v1/events/:id.
func GetEvent(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}
		eventID, ok := parseEventID(c)
		if !ok {
			return nil
		}
		detail, err := svc.Get(c.UserContext(), eventID, userID, userRole)
		if err != nil {
			return writeEventError(c, err, "event.get", "failed to load event")
		}
		members := make([]MemberResponse, len(detail.Members))
		for i, m := range detail.Members {
			members[i] = buildMemberResponse(m)
		}
		return c.JSON(EventDetailResponse{
			EventResponse: buildEventResponse(services.EventListItem{
				Event:       detail.Event,
				Creator:     detail.Creator,
				MemberCount: detail.MemberCount,
			}),
			Members: members,
		})
	}
}

// UpdateEvent returns a handler for PATCH /api/v1/events/:id.
// On a successful allowance change, fires RecalculateEventScores best-effort —
// failures are logged but don't fail the response (the event row is already saved).
func UpdateEvent(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}
		eventID, ok := parseEventID(c)
		if !ok {
			return nil
		}
		var req UpdateEventRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		result, err := svc.Update(c.UserContext(), eventID, userID, userRole, services.UpdateEventInput{
			Name:              req.Name,
			Description:       req.Description,
			StartDate:         req.StartDate,
			EndDate:           req.EndDate,
			Status:            req.Status,
			HandicapAllowance: req.HandicapAllowance,
		})
		if err != nil {
			return writeEventError(c, err, "event.update", "failed to update event")
		}

		if result.StatusChanged {
			observability.LogInfo(c.UserContext(), "event.status_changed", "Event status changed",
				"event_id", result.Event.ID.String(),
				"status", string(result.Event.Status),
			)
		}

		if result.AllowanceChanged {
			if err := services.RecalculateEventScores(c.UserContext(), svc.DB, eventID, result.Event.HandicapAllowance); err != nil {
				observability.LogInfo(c.UserContext(), "event.handicap_allowance_recalc_error",
					"Failed to recalculate scores after allowance change",
					"event_id", eventID.String(),
					"error", err.Error(),
				)
			} else {
				observability.LogInfo(c.UserContext(), "event.handicap_allowance_changed",
					"Handicap allowance updated; scores recalculated",
					"event_id", eventID.String(),
				)
			}
		}

		return c.JSON(buildEventResponse(services.EventListItem{
			Event:       result.Event,
			Creator:     result.Creator,
			MemberCount: result.MemberCount,
		}))
	}
}

// DeleteEvent returns a handler for DELETE /api/v1/events/:id.
func DeleteEvent(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}
		eventID, ok := parseEventID(c)
		if !ok {
			return nil
		}
		if err := svc.Delete(c.UserContext(), eventID, userID, userRole); err != nil {
			return writeEventError(c, err, "event.delete", "failed to delete event")
		}
		return c.SendStatus(fiber.StatusNoContent)
	}
}

// GetEventMembers returns a handler for GET /api/v1/events/:id/members.
func GetEventMembers(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		eventID, ok := parseEventID(c)
		if !ok {
			return nil
		}
		members, err := svc.GetMembers(c.UserContext(), eventID)
		if err != nil {
			return writeEventError(c, err, "event.get_members", "failed to load members")
		}
		out := make([]MemberResponse, len(members))
		for i, m := range members {
			out[i] = buildMemberResponse(m)
		}
		return c.JSON(out)
	}
}

// AddEventMember returns a handler for POST /api/v1/events/:id/members.
func AddEventMember(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}
		eventID, ok := parseEventID(c)
		if !ok {
			return nil
		}
		var req AddMemberRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}
		targetUserID, err := uuid.Parse(req.UserID)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user_id"})
		}
		member, err := svc.AddMember(c.UserContext(), eventID, userID, userRole, targetUserID)
		if err != nil {
			return writeEventError(c, err, "event.add_member", "failed to add member")
		}
		return c.Status(fiber.StatusCreated).JSON(buildMemberResponse(member))
	}
}

// RemoveEventMember returns a handler for DELETE /api/v1/events/:id/members/:userId.
func RemoveEventMember(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}
		eventID, ok := parseEventID(c)
		if !ok {
			return nil
		}
		targetUserID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID in path"})
		}
		if err := svc.RemoveMember(c.UserContext(), eventID, userID, userRole, targetUserID); err != nil {
			return writeEventError(c, err, "event.remove_member", "failed to remove member")
		}
		return c.SendStatus(fiber.StatusNoContent)
	}
}

// GetEventRounds returns a handler for GET /api/v1/events/:id/rounds.
func GetEventRounds(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		eventID, ok := parseEventID(c)
		if !ok {
			return nil
		}
		items, err := svc.GetRounds(c.UserContext(), eventID)
		if err != nil {
			return writeEventError(c, err, "event.get_rounds", "failed to load rounds")
		}
		out := make([]RoundSummaryResponse, len(items))
		for i, item := range items {
			out[i] = RoundSummaryResponse{
				ID:            item.Round.ID.String(),
				Name:          item.Round.Name,
				CourseName:    item.CourseName,
				ScheduledDate: item.Round.ScheduledDate.UTC().Format("2006-01-02"),
				Status:        string(item.Round.Status),
				ScoringFormat: string(item.Round.ScoringFormat),
				RoundNumber:   item.Round.RoundNumber,
				GroupCount:    item.GroupCount,
			}
		}
		return c.JSON(out)
	}
}

// ─── Round scheduling (kept in this file pending PR #3) ────────────────────────

// ScheduleEventRound creates a Round under an event. The route lives under
// /events/:id/rounds, but the operation is logically a Rounds-domain mutation
// that creates a Round + its initial Groups + (legacy) finds-or-creates a Course.
// PR #3 will move this handler's body into RoundsService and leave only the
// HTTP plumbing here. The IsOrganizer check goes through EventService so we
// don't fork the permission logic.
func ScheduleEventRound(eventSvc *services.EventService, db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}
		eventID, ok := parseEventID(c)
		if !ok {
			return nil
		}

		authorized, err := eventSvc.IsOrganizer(c.UserContext(), eventID, userID, userRole)
		if err != nil {
			return writeEventError(c, err, "event.schedule_round.authz", "failed to check authorization")
		}
		if !authorized {
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
			groupInputs = []GroupInput{{}}
		}

		txErr := db.WithContext(c.UserContext()).Transaction(func(tx *gorm.DB) error {
			var course models.Course
			var teeID uuid.UUID

			if req.CourseID != nil {
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
				courseErr := tx.Where("name ILIKE ?", req.CourseName).First(&course).Error
				if courseErr != nil {
					course = models.Course{Name: req.CourseName, HoleCount: 18}
					if err := tx.Create(&course).Error; err != nil {
						return err
					}
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
				if g.TeeTime != nil && *g.TeeTime != "" {
					var parsedTime time.Time
					var parseErr error
					parsedTime, parseErr = time.Parse("15:04", *g.TeeTime)
					if parseErr != nil {
						parsedTime, parseErr = time.Parse("3:04 PM", *g.TeeTime)
					}
					if parseErr == nil {
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
			if fe, ok := txErr.(*fiber.Error); ok {
				return c.Status(fe.Code).JSON(fiber.Map{"error": fe.Message})
			}
			c.Locals("error_detail", "event.schedule_round: "+txErr.Error())
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
