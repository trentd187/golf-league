// Package handlers contains HTTP route handler functions for the Golf League API.
// This file handles all /api/v1/events routes:
//
//	GET    /events                           — list events (filtered by membership)
//	GET    /events/public                    — list public events the caller is not in
//	POST   /events                           — create a new event
//	GET    /events/:id                       — event detail + members list
//	PATCH  /events/:id                       — update event name/description/dates/status/is_public
//	DELETE /events/:id                       — delete an event (cascades)
//	GET    /events/:id/members              — list event members
//	POST   /events/:id/members              — add a member
//	DELETE /events/:id/members/:userId      — remove a member
//	PATCH  /events/:id/members/:userId/role — promote/demote a member (organizer ↔ player)
//	GET    /events/:id/rounds               — list rounds for an event
//	POST   /events/:id/rounds               — schedule a new round
//	POST   /events/:id/request-join         — submit a join request (public events)
//	GET    /events/:id/join-requests        — list pending join requests (organizer only)
//	PATCH  /events/:id/join-requests/:userId — approve or deny a join request
//
// All business logic lives in internal/services.EventService. Each handler
// here parses HTTP input (URL params, JSON body, content-type), calls the
// service, and translates (value, error) into HTTP status + JSON via
// writeEventError, which also records error_detail on every 5xx so causes
// flow into Loki.
package handlers

import (
	"errors"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/services"
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
	IsPublic          bool     `json:"is_public"`
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
	IsPublic          bool     `json:"is_public"`
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
	IsPublic          *bool    `json:"is_public"`
}

// JoinRequestActionRequest is the body for PATCH /api/v1/events/:id/join-requests/:userId.
type JoinRequestActionRequest struct {
	Approve bool `json:"approve"`
}

// UpdateMemberRoleRequest is the body for PATCH /api/v1/events/:id/members/:userId/role.
type UpdateMemberRoleRequest struct {
	Role string `json:"role"`
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
		_ = c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{jsonKeyError: "invalid user ID"})
		return uuid.Nil, "", false
	}
	return userID, userRole, true
}

// parseEventID parses ":id" as a UUID. Writes 400 + returns false on failure.
func parseEventID(c *fiber.Ctx) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		_ = c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid event ID"})
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
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: ve.Message})
	}
	switch {
	case errors.Is(err, services.ErrEventNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{jsonKeyError: "event not found"})
	case errors.Is(err, services.ErrUserNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{jsonKeyError: "user not found"})
	case errors.Is(err, services.ErrMemberNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{jsonKeyError: "member not found"})
	case errors.Is(err, services.ErrJoinRequestNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{jsonKeyError: "join request not found"})
	case errors.Is(err, services.ErrEventForbidden):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{jsonKeyError: "not authorized"})
	case errors.Is(err, services.ErrEventNotMember):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{jsonKeyError: "not a member of this event"})
	case errors.Is(err, services.ErrEventNotPublic):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{jsonKeyError: "event is not open for join requests"})
	case errors.Is(err, services.ErrMemberAlreadyExists):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{jsonKeyError: "user is already a member"})
	case errors.Is(err, services.ErrLastOrganizer):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			jsonKeyError: "cannot remove the last organizer; promote another member first",
		})
	case errors.Is(err, services.ErrInvalidRole):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "role must be 'organizer' or 'player'"})
	}
	c.Locals("error_detail", tag+": "+err.Error())
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{jsonKeyError: fallbackMsg})
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
		IsPublic:          item.Event.IsPublic,
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
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid request body"})
		}
		item, err := svc.Create(c.UserContext(), services.CreateEventInput{
			Name:              req.Name,
			Description:       req.Description,
			EventType:         req.EventType,
			StartDate:         req.StartDate,
			EndDate:           req.EndDate,
			HandicapAllowance: req.HandicapAllowance,
			IsPublic:          req.IsPublic,
			CreatedBy:         userID,
		})
		if err != nil {
			return writeEventError(c, err, "event.create", "failed to create event")
		}
		slog.InfoContext(c.UserContext(), "Event created",
			"event_type_label", "event.created",
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
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid request body"})
		}
		result, err := svc.Update(c.UserContext(), eventID, userID, userRole, services.UpdateEventInput{
			Name:              req.Name,
			Description:       req.Description,
			StartDate:         req.StartDate,
			EndDate:           req.EndDate,
			Status:            req.Status,
			HandicapAllowance: req.HandicapAllowance,
			IsPublic:          req.IsPublic,
		})
		if err != nil {
			return writeEventError(c, err, "event.update", "failed to update event")
		}

		if result.StatusChanged {
			slog.InfoContext(c.UserContext(), "Event status changed",
				"event_type_label", "event.status_changed",
				"event_id", result.Event.ID.String(),
				"status", string(result.Event.Status),
			)
		}

		if result.AllowanceChanged {
			if err := services.RecalculateEventScores(c.UserContext(), svc.DB, eventID, result.Event.HandicapAllowance); err != nil {
				// ErrorContext (not InfoContext) so this lands in Sentry Issues — recalc
				// failure leaves event scores out of sync with the new allowance.
				slog.ErrorContext(c.UserContext(), "Failed to recalculate scores after allowance change",
					"event_type_label", "event.handicap_allowance_recalc_error",
					"event_id", eventID.String(),
					"error", err.Error(),
				)
			} else {
				slog.InfoContext(c.UserContext(), "Handicap allowance updated; scores recalculated",
					"event_type_label", "event.handicap_allowance_changed",
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
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid request body"})
		}
		targetUserID, err := uuid.Parse(req.UserID)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid user_id"})
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
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid user ID in path"})
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

// GetPublicEvents returns a handler for GET /api/v1/events/public.
// Returns all public events the caller is not already a member of.
func GetPublicEvents(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, _, ok := authUser(c)
		if !ok {
			return nil
		}
		items, err := svc.ListPublic(c.UserContext(), userID)
		if err != nil {
			return writeEventError(c, err, "event.list_public", "failed to fetch public events")
		}
		out := make([]EventResponse, 0, len(items))
		for _, item := range items {
			out = append(out, buildEventResponse(item))
		}
		return c.JSON(out)
	}
}

// RequestJoinEvent returns a handler for POST /api/v1/events/:id/request-join.
func RequestJoinEvent(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, _, ok := authUser(c)
		if !ok {
			return nil
		}
		eventID, ok := parseEventID(c)
		if !ok {
			return nil
		}
		if err := svc.RequestJoin(c.UserContext(), eventID, userID); err != nil {
			return writeEventError(c, err, "event.request_join", "failed to submit join request")
		}
		return c.SendStatus(fiber.StatusNoContent)
	}
}

// GetJoinRequests returns a handler for GET /api/v1/events/:id/join-requests.
// Organizer-only: returns all pending join requests.
func GetJoinRequests(svc *services.EventService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}
		eventID, ok := parseEventID(c)
		if !ok {
			return nil
		}
		items, err := svc.ListJoinRequests(c.UserContext(), eventID, userID, userRole)
		if err != nil {
			return writeEventError(c, err, "event.list_join_requests", "failed to load join requests")
		}
		out := make([]MemberResponse, len(items))
		for i, m := range items {
			out[i] = buildMemberResponse(m)
		}
		return c.JSON(out)
	}
}

// HandleJoinRequest returns a handler for PATCH /api/v1/events/:id/join-requests/:userId.
// Body: {"approve": true|false}
func HandleJoinRequest(svc *services.EventService) fiber.Handler {
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
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid user ID in path"})
		}
		var req JoinRequestActionRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid request body"})
		}
		if err := svc.HandleJoinRequest(c.UserContext(), eventID, userID, userRole, targetUserID, req.Approve); err != nil {
			return writeEventError(c, err, "event.handle_join_request", "failed to handle join request")
		}
		return c.SendStatus(fiber.StatusNoContent)
	}
}

// UpdateMemberRole returns a handler for PATCH /api/v1/events/:id/members/:userId/role.
// Body: {"role": "organizer"|"player"}
func UpdateMemberRole(svc *services.EventService) fiber.Handler {
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
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid user ID in path"})
		}
		var req UpdateMemberRoleRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid request body"})
		}
		if err := svc.UpdateMemberRole(c.UserContext(), eventID, userID, userRole, targetUserID, req.Role); err != nil {
			return writeEventError(c, err, "event.update_member_role", "failed to update member role")
		}
		return c.SendStatus(fiber.StatusNoContent)
	}
}

// ─── Round scheduling ─────────────────────────────────────────────────────────

// ScheduleEventRound creates a Round under an event. The route lives under
// /events/:id/rounds (event ownership), but the domain logic now lives in
// RoundService.Schedule so the permission and creation logic are not forked.
func ScheduleEventRound(roundSvc *services.RoundService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userID, userRole, ok := authUser(c)
		if !ok {
			return nil
		}
		eventID, ok := parseEventID(c)
		if !ok {
			return nil
		}

		var req ScheduleRoundRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{jsonKeyError: "invalid request body"})
		}

		groups := make([]services.GroupScheduleInput, len(req.Groups))
		for i, g := range req.Groups {
			groups[i] = services.GroupScheduleInput{TeeTime: g.TeeTime}
		}

		result, err := roundSvc.Schedule(c.UserContext(), eventID, userID, userRole, services.ScheduleRoundInput{
			Name:              req.Name,
			ScheduledDate:     req.ScheduledDate,
			ScoringFormat:     req.ScoringFormat,
			CourseID:          req.CourseID,
			DefaultTeeID:      req.DefaultTeeID,
			CourseName:        req.CourseName,
			NineHoleSelection: req.NineHoleSelection,
			Groups:            groups,
		})
		if err != nil {
			return writeRoundError(c, err, "event.schedule_round", "failed to schedule round")
		}

		slog.InfoContext(c.UserContext(), "Round scheduled",
			"event_type_label", "round.created",
			"round_id", result.Round.ID.String(),
			"event_id", eventID.String(),
		)

		return c.Status(fiber.StatusCreated).JSON(RoundSummaryResponse{
			ID:            result.Round.ID.String(),
			Name:          result.Round.Name,
			CourseName:    result.CourseName,
			ScheduledDate: result.Round.ScheduledDate.UTC().Format("2006-01-02"),
			Status:        string(result.Round.Status),
			ScoringFormat: string(result.Round.ScoringFormat),
			RoundNumber:   result.Round.RoundNumber,
			GroupCount:    result.GroupCount,
		})
	}
}
