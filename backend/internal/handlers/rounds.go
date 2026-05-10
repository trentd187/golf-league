// handlers/rounds.go
// HTTP handlers for individual round management and group player assignment.
// All business logic lives in internal/services.RoundService. Each handler
// here parses HTTP input (URL params, JSON body), calls the service, and
// translates the (value, error) result into HTTP status + JSON via
// writeRoundError (which records error_detail on every 5xx for Loki).
//
// Endpoints:
//
//	GET    /api/v1/rounds                                     → my rounds
//	GET    /api/v1/rounds/:roundId                            → round detail
//	PATCH  /api/v1/rounds/:roundId                            → update round
//	DELETE /api/v1/rounds/:roundId                            → delete round
//	POST   /api/v1/rounds/:roundId/groups                     → create group
//	PATCH  /api/v1/rounds/:roundId/groups/:groupId            → update group
//	DELETE /api/v1/rounds/:roundId/groups/:groupId            → delete group
//	POST   /api/v1/rounds/:roundId/groups/:groupId/members    → add member
//	DELETE /api/v1/rounds/:roundId/groups/:groupId/members/:userId → remove member
package handlers

import (
	"errors"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/services"
)

// ─── Response types ───────────────────────────────────────────────────────────

// GroupMemberResponse represents one player assigned to a group.
type GroupMemberResponse struct {
	UserID        string  `json:"user_id"`
	RoundPlayerID string  `json:"round_player_id"` // used for removal operations
	DisplayName   string  `json:"display_name"`
	Email         string  `json:"email"`
	AvatarURL     *string `json:"avatar_url"`
}

// GroupResponse represents one tee-time group with its assigned players.
type GroupResponse struct {
	ID           string                `json:"id"`
	GroupNumber  int                   `json:"group_number"`
	Name         *string               `json:"name"`          // null = use "Group N"
	TeeTime      *string               `json:"tee_time"`      // "3:04 PM" or null
	StartingHole int                   `json:"starting_hole"` // usually 1; shotgun starts differ
	Players      []GroupMemberResponse `json:"players"`
}

// RoundDetailResponse is the full round payload returned by GET /api/v1/rounds/:roundId.
type RoundDetailResponse struct {
	ID            string `json:"id"`
	EventID       string `json:"event_id"`
	Name          string `json:"name"`
	CourseName    string `json:"course_name"`
	ScheduledDate string `json:"scheduled_date"` // "YYYY-MM-DD"
	Status        string `json:"status"`
	ScoringFormat string `json:"scoring_format"`
	RoundNumber   int    `json:"round_number"`
	// IsOrganizer is computed server-side so the client skips a separate permission query.
	IsOrganizer bool            `json:"is_organizer"`
	Groups      []GroupResponse `json:"groups"`
}

// MyRoundResponse extends a round summary with event context so the Rounds tab
// can display both round name and event name without a second query.
type MyRoundResponse struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	EventID       string  `json:"event_id"`
	EventName     string  `json:"event_name"`
	CourseName    string  `json:"course_name"`
	TeeName       string  `json:"tee_name"`
	TeePar        int     `json:"tee_par"`
	CourseRating  float64 `json:"course_rating"`
	SlopeRating   int     `json:"slope_rating"`
	ScheduledDate string  `json:"scheduled_date"`
	Status        string  `json:"status"`
	ScoringFormat string  `json:"scoring_format"`
	RoundNumber   int     `json:"round_number"`
	GroupCount    int     `json:"group_count"`
}

// ─── Request types ────────────────────────────────────────────────────────────

// UpdateRoundRequest is the JSON body for PATCH /api/v1/rounds/:roundId.
// All fields are optional — only non-nil fields are applied.
type UpdateRoundRequest struct {
	Name          *string `json:"name"`
	ScheduledDate *string `json:"scheduled_date"` // "YYYY-MM-DD"
	ScoringFormat *string `json:"scoring_format"`
	// Status advances the round's lifecycle: "scheduled" → "active" → "completed".
	Status *string `json:"status"`
	// CourseID is the preferred course selector; requires DefaultTeeID.
	CourseID     *string `json:"course_id"`
	DefaultTeeID *string `json:"default_tee_id"`
	// CourseName is the legacy find-or-create fallback. Prefer CourseID.
	CourseName *string `json:"course_name"`
}

// UpdateGroupRequest is the JSON body for PATCH .../groups/:groupId.
// Both fields are optional. Send "" to clear a field.
type UpdateGroupRequest struct {
	Name    *string `json:"name"`
	TeeTime *string `json:"tee_time"` // "15:04" or "3:04 PM"; "" clears
}

// AddGroupMemberRequest is the JSON body for POST .../groups/:groupId/members.
type AddGroupMemberRequest struct {
	UserID string `json:"user_id"` // UUID of the event member to add
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

// parseRoundID parses the ":roundId" path param. Writes 400 + returns false on failure.
func parseRoundID(c *fiber.Ctx) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Params("roundId"))
	if err != nil {
		_ = c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid round ID"})
		return uuid.Nil, false
	}
	return id, true
}

// parseGroupID parses the ":groupId" path param. Writes 400 + returns false on failure.
func parseGroupID(c *fiber.Ctx) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Params("groupId"))
	if err != nil {
		_ = c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid group ID"})
		return uuid.Nil, false
	}
	return id, true
}

// writeRoundError translates a service error into HTTP status + JSON body.
// For every 5xx it sets c.Locals("error_detail", "<tag>: <cause>") so the
// HTTPMetrics middleware emits the cause in the Loki http.error log line.
//
// Always returns nil — handlers do `return writeRoundError(c, err, ...)`.
func writeRoundError(c *fiber.Ctx, err error, tag, fallbackMsg string) error {
	var ve *services.ValidationError
	if errors.As(err, &ve) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": ve.Message})
	}
	switch {
	case errors.Is(err, services.ErrRoundNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
	case errors.Is(err, services.ErrGroupNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "group not found for this round"})
	case errors.Is(err, services.ErrCourseNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "course not found"})
	case errors.Is(err, services.ErrTeeNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "tee not found for this course"})
	case errors.Is(err, services.ErrPlayerNotEventMember):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user is not a member of this event"})
	case errors.Is(err, services.ErrPlayerNotInRound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "player is not registered for this round"})
	case errors.Is(err, services.ErrRoundForbidden):
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
	case errors.Is(err, services.ErrGroupFull):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "group is full (max 4 players)"})
	case errors.Is(err, services.ErrPlayerAlreadyInGroup):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "player is already assigned to a group in this round"})
	}
	c.Locals("error_detail", tag+": "+err.Error())
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": fallbackMsg})
}

// formatTeeTime converts a *time.Time to the "3:04 PM" string the client expects,
// or returns nil when the group has no tee time set.
func formatTeeTime(t *time.Time) *string {
	if t == nil {
		return nil
	}
	// "3:04 PM" is Go's reference time format for 12-hour clock with AM/PM.
	s := t.UTC().Format("3:04 PM")
	return &s
}

// toGroupResponse converts service-layer group data to the JSON response shape.
func toGroupResponse(id string, groupNumber int, name *string, teeTime *time.Time, startingHole int, players []services.GroupPlayerResult) GroupResponse {
	playerResponses := make([]GroupMemberResponse, len(players))
	for i, p := range players {
		playerResponses[i] = GroupMemberResponse{
			UserID:        p.UserID,
			RoundPlayerID: p.RoundPlayerID,
			DisplayName:   p.DisplayName,
			Email:         p.Email,
			AvatarURL:     p.AvatarURL,
		}
	}
	return GroupResponse{
		ID:           id,
		GroupNumber:  groupNumber,
		Name:         name,
		TeeTime:      formatTeeTime(teeTime),
		StartingHole: startingHole,
		Players:      playerResponses,
	}
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// GetMyRounds returns a handler for GET /api/v1/rounds.
// Returns all rounds in events the authenticated user is a member of,
// ordered by scheduled_date descending (most recent first).
func GetMyRounds(svc *services.RoundService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerID, _, ok := authUser(c)
		if !ok {
			return nil
		}

		results, err := svc.GetMyRounds(c.UserContext(), callerID)
		if err != nil {
			return writeRoundError(c, err, "round.get_my_rounds", "failed to fetch rounds")
		}

		out := make([]MyRoundResponse, len(results))
		for i, r := range results {
			out[i] = MyRoundResponse{
				ID:            r.Round.ID.String(),
				Name:          r.Round.Name,
				EventID:       r.Round.EventID.String(),
				EventName:     r.EventName,
				CourseName:    r.CourseName,
				TeeName:       r.TeeName,
				TeePar:        r.TeePar,
				CourseRating:  r.CourseRating,
				SlopeRating:   r.SlopeRating,
				ScheduledDate: r.Round.ScheduledDate.UTC().Format("2006-01-02"),
				Status:        string(r.Round.Status),
				ScoringFormat: string(r.Round.ScoringFormat),
				RoundNumber:   r.Round.RoundNumber,
				GroupCount:    r.GroupCount,
			}
		}
		return c.JSON(out)
	}
}

// GetRound returns a handler for GET /api/v1/rounds/:roundId.
// Returns full round details including all tee-time groups and their assigned players.
// The response includes is_organizer so the client knows whether to show edit controls.
func GetRound(svc *services.RoundService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerID, callerRole, ok := authUser(c)
		if !ok {
			return nil
		}
		roundID, ok := parseRoundID(c)
		if !ok {
			return nil
		}

		result, err := svc.Get(c.UserContext(), roundID, callerID, callerRole)
		if err != nil {
			return writeRoundError(c, err, "round.get", "failed to load round")
		}

		groupResponses := make([]GroupResponse, len(result.Groups))
		for i, g := range result.Groups {
			groupResponses[i] = toGroupResponse(
				g.Group.ID.String(), g.Group.GroupNumber, g.Group.Name, g.Group.TeeTime, g.Group.StartingHole, g.Players,
			)
		}

		return c.JSON(RoundDetailResponse{
			ID:            result.Round.ID.String(),
			EventID:       result.Round.EventID.String(),
			Name:          result.Round.Name,
			CourseName:    result.Round.Course.Name,
			ScheduledDate: result.Round.ScheduledDate.UTC().Format("2006-01-02"),
			Status:        string(result.Round.Status),
			ScoringFormat: string(result.Round.ScoringFormat),
			RoundNumber:   result.Round.RoundNumber,
			IsOrganizer:   result.IsOrganizer,
			Groups:        groupResponses,
		})
	}
}

// UpdateRound returns a handler for PATCH /api/v1/rounds/:roundId.
// Organizer-only. Updates any combination of name, course, date, status, or format.
func UpdateRound(svc *services.RoundService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerID, callerRole, ok := authUser(c)
		if !ok {
			return nil
		}
		roundID, ok := parseRoundID(c)
		if !ok {
			return nil
		}

		var req UpdateRoundRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		result, err := svc.Update(c.UserContext(), roundID, callerID, callerRole, services.UpdateRoundInput{
			Name:          req.Name,
			ScheduledDate: req.ScheduledDate,
			ScoringFormat: req.ScoringFormat,
			Status:        req.Status,
			CourseID:      req.CourseID,
			DefaultTeeID:  req.DefaultTeeID,
			CourseName:    req.CourseName,
		})
		if err != nil {
			return writeRoundError(c, err, "round.update", "failed to update round")
		}

		return c.JSON(RoundSummaryResponse{
			ID:            result.Round.ID.String(),
			Name:          result.Round.Name,
			CourseName:    result.CourseName,
			ScheduledDate: result.Round.ScheduledDate.UTC().Format("2006-01-02"),
			Status:        string(result.Round.Status),
			ScoringFormat: string(result.Round.ScoringFormat),
			RoundNumber:   result.Round.RoundNumber,
		})
	}
}

// DeleteRound returns a handler for DELETE /api/v1/rounds/:roundId.
// Permanently deletes the round and all its children via ON DELETE CASCADE.
// Organizer-only.
func DeleteRound(svc *services.RoundService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerID, callerRole, ok := authUser(c)
		if !ok {
			return nil
		}
		roundID, ok := parseRoundID(c)
		if !ok {
			return nil
		}

		if err := svc.Delete(c.UserContext(), roundID, callerID, callerRole); err != nil {
			return writeRoundError(c, err, "round.delete", "failed to delete round")
		}
		return c.SendStatus(fiber.StatusNoContent)
	}
}

// CreateGroup returns a handler for POST /api/v1/rounds/:roundId/groups.
// Creates a new empty tee-time group numbered one higher than the current maximum.
// Organizer-only.
func CreateGroup(svc *services.RoundService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerID, callerRole, ok := authUser(c)
		if !ok {
			return nil
		}
		roundID, ok := parseRoundID(c)
		if !ok {
			return nil
		}

		result, err := svc.CreateGroup(c.UserContext(), roundID, callerID, callerRole)
		if err != nil {
			return writeRoundError(c, err, "round.create_group", "failed to create group")
		}

		return c.Status(fiber.StatusCreated).JSON(
			toGroupResponse(result.Group.ID.String(), result.Group.GroupNumber, result.Group.Name, result.Group.TeeTime, result.Group.StartingHole, result.Players),
		)
	}
}

// UpdateGroup returns a handler for PATCH /api/v1/rounds/:roundId/groups/:groupId.
// Allows organizers to set a custom name and/or tee time on a group.
func UpdateGroup(svc *services.RoundService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerID, callerRole, ok := authUser(c)
		if !ok {
			return nil
		}
		roundID, ok := parseRoundID(c)
		if !ok {
			return nil
		}
		groupID, ok := parseGroupID(c)
		if !ok {
			return nil
		}

		var req UpdateGroupRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		result, err := svc.UpdateGroup(c.UserContext(), roundID, groupID, callerID, callerRole, services.UpdateGroupInput{
			Name:    req.Name,
			TeeTime: req.TeeTime,
		})
		if err != nil {
			return writeRoundError(c, err, "round.update_group", "failed to update group")
		}

		return c.JSON(
			toGroupResponse(result.Group.ID.String(), result.Group.GroupNumber, result.Group.Name, result.Group.TeeTime, result.Group.StartingHole, result.Players),
		)
	}
}

// DeleteGroup returns a handler for DELETE /api/v1/rounds/:roundId/groups/:groupId.
// Removes a tee-time group. group_players cascade; round_players are kept so players
// remain registered and can be reassigned. Organizer-only.
func DeleteGroup(svc *services.RoundService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerID, callerRole, ok := authUser(c)
		if !ok {
			return nil
		}
		roundID, ok := parseRoundID(c)
		if !ok {
			return nil
		}
		groupID, ok := parseGroupID(c)
		if !ok {
			return nil
		}

		if err := svc.DeleteGroup(c.UserContext(), roundID, groupID, callerID, callerRole); err != nil {
			return writeRoundError(c, err, "round.delete_group", "failed to delete group")
		}
		return c.SendStatus(fiber.StatusNoContent)
	}
}

// AddGroupMember returns a handler for POST .../groups/:groupId/members.
// Adds an event member to a tee-time group, creating a RoundPlayer if needed.
// Enforces a 4-player maximum and prevents duplicate group assignment. Organizer-only.
func AddGroupMember(svc *services.RoundService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerID, callerRole, ok := authUser(c)
		if !ok {
			return nil
		}
		roundID, ok := parseRoundID(c)
		if !ok {
			return nil
		}
		groupID, ok := parseGroupID(c)
		if !ok {
			return nil
		}

		var req AddGroupMemberRequest
		if err := c.BodyParser(&req); err != nil || req.UserID == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "user_id is required"})
		}
		targetUserID, err := uuid.Parse(req.UserID)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user_id"})
		}

		result, err := svc.AddGroupMember(c.UserContext(), roundID, groupID, callerID, targetUserID, callerRole)
		if err != nil {
			return writeRoundError(c, err, "round.add_group_member", "failed to add player to group")
		}

		return c.Status(fiber.StatusCreated).JSON(
			toGroupResponse(result.Group.ID.String(), result.Group.GroupNumber, result.Group.Name, result.Group.TeeTime, result.Group.StartingHole, result.Players),
		)
	}
}

// RemoveGroupMember returns a handler for DELETE .../groups/:groupId/members/:userId.
// Removes a player from a group by deleting their RoundPlayer. The GroupPlayer join
// row cascades automatically via ON DELETE CASCADE. Organizer-only.
func RemoveGroupMember(svc *services.RoundService) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerID, callerRole, ok := authUser(c)
		if !ok {
			return nil
		}
		roundID, ok := parseRoundID(c)
		if !ok {
			return nil
		}
		groupID, ok := parseGroupID(c)
		if !ok {
			return nil
		}
		targetUserID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		if err := svc.RemoveGroupMember(c.UserContext(), roundID, groupID, callerID, targetUserID, callerRole); err != nil {
			return writeRoundError(c, err, "round.remove_group_member", "failed to remove player")
		}
		return c.SendStatus(fiber.StatusNoContent)
	}
}
