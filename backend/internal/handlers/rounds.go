// handlers/rounds.go
// HTTP handlers for individual round management and group player assignment.
//
// Endpoints provided:
//   GET  /api/v1/rounds/:roundId
//     → Returns round details including all groups and their assigned players.
//       Any authenticated event member can call this.
//
//   POST /api/v1/rounds/:roundId/groups/:groupId/members
//     → Adds an event member to a tee-time group. Creates a RoundPlayer record
//       if one doesn't already exist. Enforces a 4-player maximum per group.
//       Organizer-only.
//
//   DELETE /api/v1/rounds/:roundId/groups/:groupId/members/:userId
//     → Removes a player from a group. Deletes the RoundPlayer record, which
//       cascades to the GroupPlayer join row automatically (ON DELETE CASCADE).
//       Organizer-only.
package handlers

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
)

// ─── Response types ───────────────────────────────────────────────────────────

// GroupMemberResponse represents one player assigned to a group.
type GroupMemberResponse struct {
	UserID        string `json:"user_id"`         // The user's UUID
	RoundPlayerID string `json:"round_player_id"` // The round_player row UUID (used for removal)
	DisplayName   string `json:"display_name"`    // Human-readable name
	Email         string `json:"email"`           // Email address
}

// GroupResponse represents one tee-time group with its assigned players.
type GroupResponse struct {
	ID           string                `json:"id"`            // Group UUID
	GroupNumber  int                   `json:"group_number"`  // 1-based display order
	TeeTime      *string               `json:"tee_time"`      // "3:04 PM" or null if not set
	StartingHole int                   `json:"starting_hole"` // Hole the group tees off from (usually 1)
	Players      []GroupMemberResponse `json:"players"`       // Currently assigned players (0–4)
}

// RoundDetailResponse is the full round payload returned by GET /api/v1/rounds/:roundId.
type RoundDetailResponse struct {
	ID            string          `json:"id"`
	EventID       string          `json:"event_id"`
	Name          string          `json:"name"`           // Display name, e.g. "Round 1" or "Championship Round"
	CourseName    string          `json:"course_name"`
	ScheduledDate string          `json:"scheduled_date"` // "YYYY-MM-DD"
	Status        string          `json:"status"`
	ScoringFormat string          `json:"scoring_format"`
	RoundNumber   int             `json:"round_number"`
	// IsOrganizer tells the client whether the calling user can edit/delete this round.
	// Computed server-side so the client doesn't need a separate permission check query.
	IsOrganizer   bool            `json:"is_organizer"`
	Groups        []GroupResponse `json:"groups"` // Ordered by group_number ascending
}

// ─── Shared helper ────────────────────────────────────────────────────────────

// isRoundOrganizer checks whether the caller has organizer rights over the event
// that owns the given round. It mirrors isEventOrganizer in events.go but takes
// a round ID instead of an event ID, loading the round first to get its EventID.
//
// Note: consider extracting both functions to a shared helpers.go if more handlers
// need this pattern.
func isRoundOrganizer(db *gorm.DB, roundID, userID uuid.UUID, userRole string) (bool, uuid.UUID) {
	// Global admins can manage anything
	if userRole == "admin" {
		// We still need the eventID for subsequent queries, so load the round.
		var round models.Round
		if err := db.Select("event_id").First(&round, "id = ?", roundID).Error; err != nil {
			return true, uuid.Nil // admin shortcut — event ID not critical for the auth decision
		}
		return true, round.EventID
	}

	// Load the round to get its event_id
	var round models.Round
	if err := db.Select("event_id").First(&round, "id = ?", roundID).Error; err != nil {
		return false, uuid.Nil
	}

	// Check event-level organizer role
	var player models.EventPlayer
	err := db.Where("event_id = ? AND user_id = ?", round.EventID, userID).First(&player).Error
	return err == nil && player.Role == models.EventPlayerRoleOrganizer, round.EventID
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// GetRound returns a handler for GET /api/v1/rounds/:roundId.
// Returns full round details including all tee-time groups and their assigned players.
// No organizer check — any authenticated event member can view the round.
// The response includes is_organizer so the client knows whether to show edit/delete controls.
func GetRound(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Read caller identity from the Auth middleware context.
		// We need this to compute is_organizer for the response.
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		callerID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid round ID"})
		}

		// Load the round with its course name
		var round models.Round
		if err := db.Preload("Course").First(&round, "id = ?", roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		// Compute organizer status for this round so the client can show/hide edit controls.
		// isRoundOrganizer uses callerID and userRole — both are now consumed here.
		isOrg, _ := isRoundOrganizer(db, roundID, callerID, userRole)

		// Load all groups for this round, ordered by group_number so they display in sequence
		var groups []models.Group
		db.Where("round_id = ?", roundID).Order("group_number ASC").Find(&groups)

		// For each group, load its assigned players.
		// We navigate: GroupPlayer → RoundPlayer → EventPlayer → User
		groupResponses := make([]GroupResponse, 0, len(groups))
		for _, g := range groups {
			// Load group_players rows for this group, traversing the join chain to reach User.
			// Preload("RoundPlayer.EventPlayer.User") tells GORM to follow that chain automatically.
			type groupPlayerWithUser struct {
				GroupID       uuid.UUID
				RoundPlayerID uuid.UUID
				RoundPlayer   models.RoundPlayer
			}

			// Raw join query is more reliable than deep Preload chains in GORM.
			// We select just the columns we need for the response.
			type playerRow struct {
				RoundPlayerID string
				UserID        string
				DisplayName   string
				Email         string
			}
			var playerRows []playerRow
			db.Table("group_players gp").
				Select("gp.round_player_id, u.id as user_id, u.display_name, u.email").
				Joins("JOIN round_players rp ON rp.id = gp.round_player_id").
				Joins("JOIN event_players ep ON ep.id = rp.event_player_id").
				Joins("JOIN users u ON u.id = ep.user_id").
				Where("gp.group_id = ?", g.ID).
				Scan(&playerRows)

			players := make([]GroupMemberResponse, 0, len(playerRows))
			for _, row := range playerRows {
				players = append(players, GroupMemberResponse{
					UserID:        row.UserID,
					RoundPlayerID: row.RoundPlayerID,
					DisplayName:   row.DisplayName,
					Email:         row.Email,
				})
			}

			// Format the tee time as "3:04 PM" for display (e.g. "7:30 AM")
			var teeTimeStr *string
			if g.TeeTime != nil {
				formatted := g.TeeTime.UTC().Format("3:04 PM")
				teeTimeStr = &formatted
			}

			groupResponses = append(groupResponses, GroupResponse{
				ID:           g.ID.String(),
				GroupNumber:  g.GroupNumber,
				TeeTime:      teeTimeStr,
				StartingHole: g.StartingHole,
				Players:      players,
			})
		}

		return c.JSON(RoundDetailResponse{
			ID:            round.ID.String(),
			EventID:       round.EventID.String(),
			Name:          round.Name,
			CourseName:    round.Course.Name,
			ScheduledDate: round.ScheduledDate.UTC().Format("2006-01-02"),
			Status:        string(round.Status),
			ScoringFormat: string(round.ScoringFormat),
			RoundNumber:   round.RoundNumber,
			IsOrganizer:   isOrg,
			Groups:        groupResponses,
		})
	}
}

// AddGroupMemberRequest is the JSON body for POST /api/v1/rounds/:roundId/groups/:groupId/members.
type AddGroupMemberRequest struct {
	UserID string `json:"user_id"` // UUID of the event member to add to the group
}

// AddGroupMember returns a handler for POST /api/v1/rounds/:roundId/groups/:groupId/members.
// Adds an event member to a tee-time group. Creates a RoundPlayer if needed.
// Enforces a 4-player maximum per group and prevents a player from being in two groups.
// Organizer-only.
func AddGroupMember(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		callerID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid round ID"})
		}
		groupID, err := uuid.Parse(c.Params("groupId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid group ID"})
		}

		// Permission check — organizer of the event that owns this round
		isOrganizer, eventID := isRoundOrganizer(db, roundID, callerID, userRole)
		if !isOrganizer {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}
		if eventID == uuid.Nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		var req AddGroupMemberRequest
		if err := c.BodyParser(&req); err != nil || req.UserID == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "user_id is required"})
		}
		targetUserID, err := uuid.Parse(req.UserID)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user_id"})
		}

		// Verify the group belongs to this round (prevents cross-round group tampering)
		var group models.Group
		if err := db.First(&group, "id = ? AND round_id = ?", groupID, roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "group not found for this round"})
		}

		// Enforce 4-player maximum
		var currentCount int64
		db.Model(&models.GroupPlayer{}).Where("group_id = ?", groupID).Count(&currentCount)
		if currentCount >= 4 {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "group is full (max 4 players)"})
		}

		// Look up the EventPlayer for the target user in this event
		var eventPlayer models.EventPlayer
		if err := db.Where("event_id = ? AND user_id = ?", eventID, targetUserID).
			First(&eventPlayer).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user is not a member of this event"})
		}

		// Find or create the RoundPlayer for this event player in this round.
		// A RoundPlayer is created automatically the first time a player is added to any group.
		var roundPlayer models.RoundPlayer
		result := db.Where("round_id = ? AND event_player_id = ?", roundID, eventPlayer.ID).
			First(&roundPlayer)
		if result.Error != nil {
			// Not found — create a new RoundPlayer with "registered" status
			roundPlayer = models.RoundPlayer{
				RoundID:       roundID,
				EventPlayerID: eventPlayer.ID,
				Status:        models.RoundPlayerStatusRegistered,
			}
			if err := db.Create(&roundPlayer).Error; err != nil {
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to register player for round"})
			}
		}

		// Check if this player is already in another group for this round.
		// A player can only be in one group per round (the GroupPlayer composite PK already
		// prevents duplicates per group, but we want a cleaner error message here).
		var existingGroupPlayer models.GroupPlayer
		alreadyAssigned := db.
			Joins("JOIN groups g ON g.id = group_players.group_id").
			Where("group_players.round_player_id = ? AND g.round_id = ?", roundPlayer.ID, roundID).
			First(&existingGroupPlayer).Error == nil
		if alreadyAssigned {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "player is already assigned to a group in this round"})
		}

		// Create the GroupPlayer join record
		groupPlayerRecord := models.GroupPlayer{
			GroupID:       groupID,
			RoundPlayerID: roundPlayer.ID,
		}
		if err := db.Create(&groupPlayerRecord).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to add player to group"})
		}

		// Return the updated group so the client can refresh without a separate GET
		return c.Status(fiber.StatusCreated).JSON(buildGroupResponse(db, group))
	}
}

// RemoveGroupMember returns a handler for DELETE /api/v1/rounds/:roundId/groups/:groupId/members/:userId.
// Removes a player from a group by deleting their RoundPlayer record.
// The GroupPlayer join row is removed automatically via ON DELETE CASCADE.
// Organizer-only.
func RemoveGroupMember(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		callerID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid round ID"})
		}
		groupID, err := uuid.Parse(c.Params("groupId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid group ID"})
		}
		targetUserID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		// Permission check
		isOrganizer, eventID := isRoundOrganizer(db, roundID, callerID, userRole)
		if !isOrganizer {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}
		if eventID == uuid.Nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		// Verify the group belongs to this round
		var group models.Group
		if err := db.First(&group, "id = ? AND round_id = ?", groupID, roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "group not found for this round"})
		}

		// Find the EventPlayer for the target user in this event
		var eventPlayer models.EventPlayer
		if err := db.Where("event_id = ? AND user_id = ?", eventID, targetUserID).
			First(&eventPlayer).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user is not a member of this event"})
		}

		// Find the RoundPlayer record for this event player in this round
		var roundPlayer models.RoundPlayer
		if err := db.Where("round_id = ? AND event_player_id = ?", roundID, eventPlayer.ID).
			First(&roundPlayer).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "player is not registered for this round"})
		}

		// Delete the RoundPlayer — the GroupPlayer join row is removed automatically
		// because group_players.round_player_id has ON DELETE CASCADE in the schema.
		if err := db.Delete(&roundPlayer).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to remove player"})
		}

		// 204 No Content — success with no response body
		return c.SendStatus(fiber.StatusNoContent)
	}
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// buildGroupResponse fetches a group's current players from the database and
// returns a GroupResponse. Used to return the updated group after add/remove operations.
func buildGroupResponse(db *gorm.DB, g models.Group) GroupResponse {
	type playerRow struct {
		RoundPlayerID string
		UserID        string
		DisplayName   string
		Email         string
	}
	var playerRows []playerRow
	db.Table("group_players gp").
		Select("gp.round_player_id, u.id as user_id, u.display_name, u.email").
		Joins("JOIN round_players rp ON rp.id = gp.round_player_id").
		Joins("JOIN event_players ep ON ep.id = rp.event_player_id").
		Joins("JOIN users u ON u.id = ep.user_id").
		Where("gp.group_id = ?", g.ID).
		Scan(&playerRows)

	players := make([]GroupMemberResponse, 0, len(playerRows))
	for _, row := range playerRows {
		players = append(players, GroupMemberResponse{
			UserID:        row.UserID,
			RoundPlayerID: row.RoundPlayerID,
			DisplayName:   row.DisplayName,
			Email:         row.Email,
		})
	}

	var teeTimeStr *string
	if g.TeeTime != nil {
		// "3:04 PM" is Go's reference time format for 12-hour clock with AM/PM.
		// It produces strings like "7:30 AM" or "12:45 PM".
		formatted := g.TeeTime.UTC().Format("3:04 PM")
		teeTimeStr = &formatted
	}

	return GroupResponse{
		ID:           g.ID.String(),
		GroupNumber:  g.GroupNumber,
		TeeTime:      teeTimeStr,
		StartingHole: g.StartingHole,
		Players:      players,
	}
}

// ─── Edit / delete handlers ────────────────────────────────────────────────────

// UpdateRoundRequest is the JSON body for PATCH /api/v1/rounds/:roundId.
// All fields are optional pointers — only non-nil fields are applied.
type UpdateRoundRequest struct {
	// Name is the display name for the round. Cannot be set to empty string.
	Name          *string `json:"name"`
	// CourseName triggers a find-or-create lookup (same logic as ScheduleEventRound).
	CourseName    *string `json:"course_name"`
	// ScheduledDate is "YYYY-MM-DD". Cannot be set to empty string.
	ScheduledDate *string `json:"scheduled_date"`
	ScoringFormat *string `json:"scoring_format"`
}

// UpdateRound returns a handler for PATCH /api/v1/rounds/:roundId.
// Organizer-only. Updates any combination of name, course, date, or scoring format.
// Returns the updated round as a RoundSummaryResponse.
func UpdateRound(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		callerID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid round ID"})
		}

		// Permission check — only organizers of the owning event may edit the round
		isOrg, _ := isRoundOrganizer(db, roundID, callerID, userRole)
		if !isOrg {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		// Load the round with its current course so we can update it
		var round models.Round
		if err := db.Preload("Course").First(&round, "id = ?", roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		var req UpdateRoundRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		// Apply only non-nil fields — partial update pattern
		if req.Name != nil {
			if *req.Name == "" {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "name cannot be empty"})
			}
			round.Name = *req.Name
		}

		if req.ScheduledDate != nil {
			if *req.ScheduledDate == "" {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "scheduled_date cannot be empty"})
			}
			parsed, err := time.Parse("2006-01-02", *req.ScheduledDate)
			if err != nil {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "scheduled_date must be YYYY-MM-DD"})
			}
			round.ScheduledDate = parsed
		}

		if req.ScoringFormat != nil && *req.ScoringFormat != "" {
			round.ScoringFormat = models.ScoringFormat(*req.ScoringFormat)
		}

		// Course name change: find the course (case-insensitive) or create it.
		// This mirrors the logic in ScheduleEventRound — no transaction needed here
		// because we're only updating, not creating the round record itself.
		if req.CourseName != nil && *req.CourseName != "" {
			var course models.Course
			if err := db.Where("name ILIKE ?", *req.CourseName).First(&course).Error; err != nil {
				// Course not found — create it with sensible defaults
				course = models.Course{Name: *req.CourseName, HoleCount: 18}
				if err := db.Create(&course).Error; err != nil {
					return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create course"})
				}
				// Create a default tee for the new course
				defaultTee := models.Tee{
					CourseID:     course.ID,
					Name:         "Default",
					Gender:       models.TeeGenderUnisex,
					CourseRating: 72.0,
					SlopeRating:  113,
					Par:          72,
				}
				if err := db.Create(&defaultTee).Error; err != nil {
					return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create tee"})
				}
				round.CourseID = course.ID
				round.DefaultTeeID = defaultTee.ID
			} else {
				// Course exists — point the round at it and use its first tee
				round.CourseID = course.ID
				var tee models.Tee
				if err := db.Where("course_id = ?", course.ID).First(&tee).Error; err != nil {
					// No tees on this course yet — create the default
					tee = models.Tee{
						CourseID:     course.ID,
						Name:         "Default",
						Gender:       models.TeeGenderUnisex,
						CourseRating: 72.0,
						SlopeRating:  113,
						Par:          72,
					}
					if err := db.Create(&tee).Error; err != nil {
						return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create tee"})
					}
				}
				round.DefaultTeeID = tee.ID
			}
		}

		// db.Save() issues an UPDATE for all columns
		if err := db.Save(&round).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update round"})
		}

		// Reload to get the fresh course name after a potential course change
		db.Preload("Course").First(&round, "id = ?", roundID)

		// Return a RoundSummaryResponse (same shape as the rounds list) so the client
		// can update its cached list without a separate GET /events/:id/rounds call.
		return c.JSON(RoundSummaryResponse{
			ID:            round.ID.String(),
			Name:          round.Name,
			CourseName:    round.Course.Name,
			ScheduledDate: round.ScheduledDate.UTC().Format("2006-01-02"),
			Status:        string(round.Status),
			ScoringFormat: string(round.ScoringFormat),
			RoundNumber:   round.RoundNumber,
		})
	}
}

// DeleteRound returns a handler for DELETE /api/v1/rounds/:roundId.
// Permanently deletes the round and all its children (groups, group_players,
// round_players, scores) via ON DELETE CASCADE in the database schema.
// Organizer-only.
func DeleteRound(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		callerID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid round ID"})
		}

		// Permission check — organizer of the event that owns this round
		isOrg, _ := isRoundOrganizer(db, roundID, callerID, userRole)
		if !isOrg {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		// Load the round so we have a concrete record to delete
		var round models.Round
		if err := db.First(&round, "id = ?", roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		// Hard delete — no DeletedAt field on Round, so GORM issues a real DELETE.
		// ON DELETE CASCADE removes groups, round_players, scores automatically.
		if err := db.Delete(&round).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to delete round"})
		}

		// 204 No Content — success with no body
		return c.SendStatus(fiber.StatusNoContent)
	}
}
