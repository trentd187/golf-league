// handlers/rounds.go
// HTTP handlers for individual round management and group player assignment.
//
// Endpoints:
//
//	GET  /api/v1/rounds/:roundId
//	  → Round details including all groups and their assigned players.
//	    Any authenticated event member can call this.
//
//	POST /api/v1/rounds/:roundId/groups
//	  → Creates a new empty tee-time group for the round, numbered one higher
//	    than the current maximum. Organizer-only.
//
//	DELETE /api/v1/rounds/:roundId/groups/:groupId
//	  → Removes the group. group_players are cascade-deleted; round_players are
//	    kept so players remain registered and can be reassigned. Organizer-only.
//
//	POST /api/v1/rounds/:roundId/groups/:groupId/members
//	  → Adds an event member to a tee-time group. Creates a RoundPlayer record
//	    if one doesn't already exist. Enforces a 4-player maximum per group.
//	    Organizer-only.
//
//	DELETE /api/v1/rounds/:roundId/groups/:groupId/members/:userId
//	  → Removes a player from a group. Deletes the RoundPlayer record, which
//	    cascades to the GroupPlayer join row automatically (ON DELETE CASCADE).
//	    Organizer-only.
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
	UserID        string `json:"user_id"`
	RoundPlayerID string `json:"round_player_id"` // used for removal operations
	DisplayName   string `json:"display_name"`
	Email         string `json:"email"`
}

// GroupResponse represents one tee-time group with its assigned players.
type GroupResponse struct {
	ID           string                `json:"id"`
	GroupNumber  int                   `json:"group_number"`
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
	// IsOrganizer is computed server-side so the client doesn't need a separate permission query.
	IsOrganizer bool            `json:"is_organizer"`
	Groups      []GroupResponse `json:"groups"`
}

// ─── Shared helper ────────────────────────────────────────────────────────────

// isRoundOrganizer checks whether the caller has organizer rights over the event
// that owns the given round. It mirrors isEventOrganizer in events.go but takes
// a round ID instead of an event ID.
//
// Returns (isOrganizer bool, eventID uuid.UUID). The event ID is returned because
// several callers need it for subsequent queries; check for uuid.Nil to detect a
// missing round.
func isRoundOrganizer(db *gorm.DB, roundID, userID uuid.UUID, userRole string) (bool, uuid.UUID) {
	if userRole == "admin" {
		// Admin bypass — still load the round to return its event ID to callers.
		var round models.Round
		if err := db.Select("event_id").First(&round, "id = ?", roundID).Error; err != nil {
			return true, uuid.Nil
		}
		return true, round.EventID
	}

	var round models.Round
	if err := db.Select("event_id").First(&round, "id = ?", roundID).Error; err != nil {
		return false, uuid.Nil
	}

	var player models.EventPlayer
	err := db.Where("event_id = ? AND user_id = ?", round.EventID, userID).First(&player).Error
	return err == nil && player.Role == models.EventPlayerRoleOrganizer, round.EventID
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// GetRound returns a handler for GET /api/v1/rounds/:roundId.
// Returns full round details including all tee-time groups and their assigned players.
// The response includes is_organizer so the client knows whether to show edit/delete controls.
func GetRound(db *gorm.DB) fiber.Handler {
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

		var round models.Round
		if err := db.Preload("Course").First(&round, "id = ?", roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		isOrg, _ := isRoundOrganizer(db, roundID, callerID, userRole)

		var groups []models.Group
		db.Where("round_id = ?", roundID).Order("group_number ASC").Find(&groups)

		// For each group, load its assigned players via a raw join.
		// A raw join is more reliable than deep Preload chains in GORM.
		groupResponses := make([]GroupResponse, 0, len(groups))
		for _, g := range groups {
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

			// "3:04 PM" is Go's reference time format for 12-hour clock with AM/PM.
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

// CreateGroup returns a handler for POST /api/v1/rounds/:roundId/groups.
// Creates a new empty tee-time group numbered one higher than the current maximum.
// Organizer-only.
func CreateGroup(db *gorm.DB) fiber.Handler {
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

		isOrg, eventID := isRoundOrganizer(db, roundID, callerID, userRole)
		if !isOrg {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}
		// uuid.Nil means the round wasn't found (admin bypass still hits the DB to get eventID).
		if eventID == uuid.Nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		// Auto-number: one higher than the current maximum, or 1 for the first group.
		var maxGroupNum int
		db.Model(&models.Group{}).
			Where("round_id = ?", roundID).
			Select("COALESCE(MAX(group_number), 0)").
			Scan(&maxGroupNum)

		group := models.Group{
			RoundID:      roundID,
			GroupNumber:  maxGroupNum + 1,
			StartingHole: 1,
		}
		if err := db.Create(&group).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create group"})
		}

		return c.Status(fiber.StatusCreated).JSON(buildGroupResponse(db, group))
	}
}

// DeleteGroup returns a handler for DELETE /api/v1/rounds/:roundId/groups/:groupId.
// Removes a tee-time group from the round. The group_players join rows are removed
// automatically via ON DELETE CASCADE; round_player records are kept so players
// remain registered in the round and can be reassigned to another group.
// Organizer-only.
func DeleteGroup(db *gorm.DB) fiber.Handler {
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

		isOrg, eventID := isRoundOrganizer(db, roundID, callerID, userRole)
		if !isOrg {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}
		if eventID == uuid.Nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		var group models.Group
		if err := db.First(&group, "id = ? AND round_id = ?", groupID, roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "group not found for this round"})
		}

		// ON DELETE CASCADE removes group_players rows automatically.
		// round_players are intentionally kept — players stay registered in the round.
		if err := db.Delete(&group).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to delete group"})
		}

		return c.SendStatus(fiber.StatusNoContent)
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

		// Verify the group belongs to this round (prevents cross-round group tampering).
		var group models.Group
		if err := db.First(&group, "id = ? AND round_id = ?", groupID, roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "group not found for this round"})
		}

		var currentCount int64
		db.Model(&models.GroupPlayer{}).Where("group_id = ?", groupID).Count(&currentCount)
		if currentCount >= 4 {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "group is full (max 4 players)"})
		}

		var eventPlayer models.EventPlayer
		if err := db.Where("event_id = ? AND user_id = ?", eventID, targetUserID).
			First(&eventPlayer).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user is not a member of this event"})
		}

		// Find or create the RoundPlayer — created automatically the first time a player joins any group.
		var roundPlayer models.RoundPlayer
		result := db.Where("round_id = ? AND event_player_id = ?", roundID, eventPlayer.ID).
			First(&roundPlayer)
		if result.Error != nil {
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
		var existingGroupPlayer models.GroupPlayer
		alreadyAssigned := db.
			Joins("JOIN groups g ON g.id = group_players.group_id").
			Where("group_players.round_player_id = ? AND g.round_id = ?", roundPlayer.ID, roundID).
			First(&existingGroupPlayer).Error == nil
		if alreadyAssigned {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "player is already assigned to a group in this round"})
		}

		groupPlayerRecord := models.GroupPlayer{
			GroupID:       groupID,
			RoundPlayerID: roundPlayer.ID,
		}
		if err := db.Create(&groupPlayerRecord).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to add player to group"})
		}

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

		isOrganizer, eventID := isRoundOrganizer(db, roundID, callerID, userRole)
		if !isOrganizer {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}
		if eventID == uuid.Nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		var group models.Group
		if err := db.First(&group, "id = ? AND round_id = ?", groupID, roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "group not found for this round"})
		}

		var eventPlayer models.EventPlayer
		if err := db.Where("event_id = ? AND user_id = ?", eventID, targetUserID).
			First(&eventPlayer).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user is not a member of this event"})
		}

		var roundPlayer models.RoundPlayer
		if err := db.Where("round_id = ? AND event_player_id = ?", roundID, eventPlayer.ID).
			First(&roundPlayer).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "player is not registered for this round"})
		}

		// Deleting RoundPlayer cascades to the GroupPlayer join row via ON DELETE CASCADE.
		if err := db.Delete(&roundPlayer).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to remove player"})
		}

		return c.SendStatus(fiber.StatusNoContent)
	}
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// buildGroupResponse fetches a group's current players and returns a GroupResponse.
// Used to return the updated group after add/remove operations.
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
	Name          *string `json:"name"`
	ScheduledDate *string `json:"scheduled_date"` // "YYYY-MM-DD"
	ScoringFormat *string `json:"scoring_format"`
	// Status allows organizers to advance a round's lifecycle:
	// "scheduled" → "active" (start the round) or "active" → "completed" (finish it).
	Status *string `json:"status"`

	// Preferred: switch to a pre-managed course by UUID.
	// When course_id is set, default_tee_id is also required.
	CourseID     *string `json:"course_id"`
	DefaultTeeID *string `json:"default_tee_id"`

	// Legacy fallback: find-or-create by name. Prefer course_id going forward.
	CourseName *string `json:"course_name"`
}

// UpdateRound returns a handler for PATCH /api/v1/rounds/:roundId.
// Organizer-only. Updates any combination of name, course, date, or scoring format.
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

		isOrg, _ := isRoundOrganizer(db, roundID, callerID, userRole)
		if !isOrg {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		var round models.Round
		if err := db.Preload("Course").First(&round, "id = ?", roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		var req UpdateRoundRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

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

		// Course change — preferred: switch by UUID (avoids find-or-create side effects).
		if req.CourseID != nil {
			if req.DefaultTeeID == nil {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "default_tee_id is required when course_id is provided"})
			}
			courseUUID, err := uuid.Parse(*req.CourseID)
			if err != nil {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid course_id"})
			}
			teeUUID, err := uuid.Parse(*req.DefaultTeeID)
			if err != nil {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid default_tee_id"})
			}
			var course models.Course
			if err := db.First(&course, "id = ?", courseUUID).Error; err != nil {
				return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "course not found"})
			}
			var tee models.Tee
			if err := db.First(&tee, "id = ? AND course_id = ?", teeUUID, courseUUID).Error; err != nil {
				return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "tee not found for this course"})
			}
			round.CourseID = courseUUID
			round.DefaultTeeID = teeUUID
		} else if req.CourseName != nil && *req.CourseName != "" {
			// Legacy fallback: find-or-create by name (same logic as ScheduleEventRound).
			var course models.Course
			if err := db.Where("name ILIKE ?", *req.CourseName).First(&course).Error; err != nil {
				course = models.Course{Name: *req.CourseName, HoleCount: 18}
				if err := db.Create(&course).Error; err != nil {
					return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to create course"})
				}
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
				round.CourseID = course.ID
				var tee models.Tee
				if err := db.Where("course_id = ?", course.ID).First(&tee).Error; err != nil {
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

		if req.Status != nil {
			switch models.RoundStatus(*req.Status) {
			case models.RoundStatusScheduled, models.RoundStatusActive, models.RoundStatusCompleted:
				round.Status = models.RoundStatus(*req.Status)
			default:
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid status value"})
			}
		}

		if err := db.Save(&round).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to update round"})
		}

		// Reload to get the fresh course name after a potential course change.
		db.Preload("Course").First(&round, "id = ?", roundID)

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
// Permanently deletes the round and all its children via ON DELETE CASCADE.
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

		isOrg, _ := isRoundOrganizer(db, roundID, callerID, userRole)
		if !isOrg {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		var round models.Round
		if err := db.First(&round, "id = ?", roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		// No DeletedAt on Round, so GORM issues a real DELETE.
		// ON DELETE CASCADE removes groups, round_players, scores automatically.
		if err := db.Delete(&round).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to delete round"})
		}

		return c.SendStatus(fiber.StatusNoContent)
	}
}
