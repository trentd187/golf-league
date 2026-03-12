// handlers/scores.go
// HTTP handlers for scorecard retrieval and score entry.
//
// Endpoints:
//
//	GET  /api/v1/rounds/:roundId/scorecard
//	  → Full scorecard: round metadata, hole data from the default tee, and all
//	    groups with each player's handicap and per-hole scores.
//	    Any authenticated event member can call this.
//
//	PUT  /api/v1/rounds/:roundId/players/:roundPlayerId/handicap
//	  → Sets the playing handicap (course_handicap) for a single round_player.
//	    Caller must be in the same tee-time group as the target player, OR be
//	    an organizer/admin.
//
//	PUT  /api/v1/rounds/:roundId/players/:roundPlayerId/scores
//	  → Bulk upsert for all holes for one player. Uses ON CONFLICT DO UPDATE so
//	    it is safe to call multiple times (idempotent per hole).
//	    Net scores are calculated from the player's course_handicap and the
//	    hole's stroke_index at save time.
//	    Same permission rule as the handicap endpoint.
package handlers

import (
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ─── Response types ───────────────────────────────────────────────────────────

// ScorecardHole holds per-hole course data from the round's default tee.
type ScorecardHole struct {
	HoleNumber  int  `json:"hole_number"`
	Par         int  `json:"par"`
	StrokeIndex int  `json:"stroke_index"`
	Yardage     *int `json:"yardage"`
}

// ScorecardScore is one player's score on one hole.
type ScorecardScore struct {
	HoleNumber int `json:"hole_number"`
	GrossScore int `json:"gross_score"`
	NetScore   int `json:"net_score"`
}

// ScorecardPlayer is a player in a group with their handicap and all hole scores.
type ScorecardPlayer struct {
	RoundPlayerID  string           `json:"round_player_id"`
	UserID         string           `json:"user_id"`
	DisplayName    string           `json:"display_name"`
	CourseHandicap *int             `json:"course_handicap"`
	Scores         []ScorecardScore `json:"scores"`
	// TotalGross / TotalNet are null when fewer holes have been scored than the
	// round's hole_count — preventing partial totals from being misleading.
	TotalGross *int `json:"total_gross"`
	TotalNet   *int `json:"total_net"`
}

// ScorecardGroupResponse is one tee-time group's slice of the scorecard.
type ScorecardGroupResponse struct {
	GroupID     string            `json:"group_id"`
	GroupNumber int               `json:"group_number"`
	Players     []ScorecardPlayer `json:"players"`
}

// ScorecardResponse is the full payload returned by GET /rounds/:roundId/scorecard.
type ScorecardResponse struct {
	RoundID          string `json:"round_id"`
	RoundName        string `json:"round_name"`
	Status           string `json:"status"`
	HoleCount        int    `json:"hole_count"`
	RequiresHandicap bool   `json:"requires_handicap"`
	ScoringFormat    string `json:"scoring_format"`
	// IsOrganizer lets the mobile client show/hide the "End Round" button without a separate query.
	IsOrganizer bool                     `json:"is_organizer"`
	Holes       []ScorecardHole          `json:"holes"`
	Groups      []ScorecardGroupResponse `json:"groups"`
}

// ─── Request types ────────────────────────────────────────────────────────────

// SetHandicapRequest is the JSON body for PUT /rounds/:roundId/players/:roundPlayerId/handicap.
type SetHandicapRequest struct {
	CourseHandicap int `json:"course_handicap"` // Playing handicap for this round
}

// ScoreInput is a single hole's score for one player.
type ScoreInput struct {
	HoleNumber int `json:"hole_number"` // 1–18
	GrossScore int `json:"gross_score"` // Total strokes taken on this hole
}

// UpsertScoresRequest is the JSON body for PUT /rounds/:roundId/players/:roundPlayerId/scores.
type UpsertScoresRequest struct {
	Scores []ScoreInput `json:"scores"`
}

// ─── Permission helper ────────────────────────────────────────────────────────

// canModifyScores returns true when the caller is allowed to enter or update
// scores for targetRoundPlayerID. The three allowed cases are:
//  1. Global admin role (full bypass)
//  2. Round organizer (can score for anyone in the round)
//  3. Caller is in the same tee-time group as the target player
func canModifyScores(db *gorm.DB, roundID, targetRoundPlayerID, callerID uuid.UUID, userRole string) bool {
	if userRole == "admin" {
		return true
	}
	// Organizer bypass — isRoundOrganizer handles manager role check internally.
	if isOrg, _ := isRoundOrganizer(db, roundID, callerID, userRole); isOrg {
		return true
	}

	// Find which group the target player belongs to.
	var targetGP models.GroupPlayer
	if err := db.First(&targetGP, "round_player_id = ?", targetRoundPlayerID).Error; err != nil {
		return false
	}

	// Resolve caller → EventPlayer → RoundPlayer for this round.
	var round models.Round
	if err := db.Select("event_id").First(&round, "id = ?", roundID).Error; err != nil {
		return false
	}
	var callerEP models.EventPlayer
	if err := db.Where("event_id = ? AND user_id = ?", round.EventID, callerID).First(&callerEP).Error; err != nil {
		return false
	}
	var callerRP models.RoundPlayer
	if err := db.Where("round_id = ? AND event_player_id = ?", roundID, callerEP.ID).First(&callerRP).Error; err != nil {
		return false
	}

	// Confirm the caller's RoundPlayer is in the same group.
	var callerGP models.GroupPlayer
	err := db.Where("round_player_id = ? AND group_id = ?", callerRP.ID, targetGP.GroupID).
		First(&callerGP).Error
	return err == nil
}

// ─── Net score helper ─────────────────────────────────────────────────────────

// HandicapStrokes returns the number of strokes a player with the given course
// handicap receives on a hole identified by its stroke_index.
//
// USGA allocation rule: a player with handicap 5 gets one stroke on holes
// whose stroke_index is ≤ 5 (the five hardest holes). A player with handicap 20
// gets two strokes on the two hardest holes (SI 1–2) and one stroke on holes 3–18.
func HandicapStrokes(courseHandicap, strokeIndex int) int {
	if courseHandicap <= 0 || strokeIndex <= 0 {
		return 0
	}
	full := courseHandicap / 18      // complete passes over all 18 holes
	remainder := courseHandicap % 18 // extra strokes distributed from SI 1 upward
	strokes := full
	if strokeIndex <= remainder {
		strokes++
	}
	return strokes
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

// GetRoundScorecard returns a handler for GET /api/v1/rounds/:roundId/scorecard.
// Returns the full scorecard: round info, hole data from the default tee, and
// all groups with each player's handicap and their per-hole scores.
// Any authenticated event member can view the scorecard.
func GetRoundScorecard(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid round ID"})
		}

		// Determine caller identity for is_organizer flag.
		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		callerID, _ := uuid.Parse(userIDStr)
		isOrg, _ := isRoundOrganizer(db, roundID, callerID, userRole)

		// Load round with its default tee and tee's holes.
		var round models.Round
		if err := db.
			Preload("DefaultTee.Holes").
			Preload("Course").
			First(&round, "id = ?", roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		// Build hole data slice from the default tee.
		// Holes are ordered by hole_number ascending.
		holeRows := make([]ScorecardHole, 0, len(round.DefaultTee.Holes))
		// Keep a lookup map for net-score calculation later.
		siByHole := make(map[int]int, len(round.DefaultTee.Holes))
		for _, h := range round.DefaultTee.Holes {
			holeRows = append(holeRows, ScorecardHole{
				HoleNumber:  h.HoleNumber,
				Par:         h.Par,
				StrokeIndex: h.StrokeIndex,
				Yardage:     h.Yardage,
			})
			siByHole[h.HoleNumber] = h.StrokeIndex
		}

		// Sort holes by hole_number — GORM doesn't guarantee preload order.
		for i := 1; i < len(holeRows); i++ {
			for j := i; j > 0 && holeRows[j].HoleNumber < holeRows[j-1].HoleNumber; j-- {
				holeRows[j], holeRows[j-1] = holeRows[j-1], holeRows[j]
			}
		}

		// Load all groups for the round, ordered for stable display.
		var groups []models.Group
		db.Where("round_id = ?", roundID).Order("group_number ASC").Find(&groups)

		groupResponses := make([]ScorecardGroupResponse, 0, len(groups))
		for _, g := range groups {
			// For each group load players via a raw join (same pattern as GetRound).
			type playerRow struct {
				RoundPlayerID  string
				UserID         string
				DisplayName    string
				CourseHandicap *int
			}
			var playerRows []playerRow
			db.Table("group_players gp").
				Select("gp.round_player_id, u.id as user_id, u.display_name, rp.course_handicap").
				Joins("JOIN round_players rp ON rp.id = gp.round_player_id").
				Joins("JOIN event_players ep ON ep.id = rp.event_player_id").
				Joins("JOIN users u ON u.id = ep.user_id").
				Where("gp.group_id = ?", g.ID).
				Scan(&playerRows)

			players := make([]ScorecardPlayer, 0, len(playerRows))
			for _, pr := range playerRows {
				rpID, _ := uuid.Parse(pr.RoundPlayerID)

				// Load all scores for this round_player.
				var dbScores []models.Score
				db.Where("round_player_id = ?", rpID).Order("hole_number ASC").Find(&dbScores)

				scores := make([]ScorecardScore, 0, len(dbScores))
				totalGross := 0
				totalNet := 0
				for _, s := range dbScores {
					scores = append(scores, ScorecardScore{
						HoleNumber: s.HoleNumber,
						GrossScore: s.GrossScore,
						NetScore:   s.NetScore,
					})
					totalGross += s.GrossScore
					totalNet += s.NetScore
				}

				// Only emit totals when all holes have been entered.
				var tg, tn *int
				if len(dbScores) >= round.Course.HoleCount {
					tg = &totalGross
					tn = &totalNet
				}

				players = append(players, ScorecardPlayer{
					RoundPlayerID:  pr.RoundPlayerID,
					UserID:         pr.UserID,
					DisplayName:    pr.DisplayName,
					CourseHandicap: pr.CourseHandicap,
					Scores:         scores,
					TotalGross:     tg,
					TotalNet:       tn,
				})
			}

			groupResponses = append(groupResponses, ScorecardGroupResponse{
				GroupID:     g.ID.String(),
				GroupNumber: g.GroupNumber,
				Players:     players,
			})
		}

		return c.JSON(ScorecardResponse{
			RoundID:          round.ID.String(),
			RoundName:        round.Name,
			Status:           string(round.Status),
			HoleCount:        round.Course.HoleCount,
			RequiresHandicap: round.RequiresHandicap,
			ScoringFormat:    string(round.ScoringFormat),
			IsOrganizer:      isOrg,
			Holes:            holeRows,
			Groups:           groupResponses,
		})
	}
}

// SetPlayerHandicap returns a handler for PUT /api/v1/rounds/:roundId/players/:roundPlayerId/handicap.
// Sets the playing handicap (course_handicap) for a single RoundPlayer.
// Permission: caller must be in the same group as the target player, OR be an organizer/admin.
func SetPlayerHandicap(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Route param validation first — lets Tier-1 tests reach 400 without needing auth context.
		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid round ID"})
		}
		roundPlayerID, err := uuid.Parse(c.Params("roundPlayerId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid round player ID"})
		}

		var req SetHandicapRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		callerID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		if !canModifyScores(db, roundID, roundPlayerID, callerID, userRole) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		// Verify the round_player belongs to this round.
		var rp models.RoundPlayer
		if err := db.First(&rp, "id = ? AND round_id = ?", roundPlayerID, roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round player not found"})
		}

		rp.CourseHandicap = &req.CourseHandicap
		if err := db.Save(&rp).Error; err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to save handicap"})
		}

		return c.JSON(fiber.Map{"course_handicap": req.CourseHandicap})
	}
}

// UpsertPlayerScores returns a handler for PUT /api/v1/rounds/:roundId/players/:roundPlayerId/scores.
// Bulk upserts all hole scores for one player. Safe to call multiple times — each hole
// uses ON CONFLICT DO UPDATE so re-submitting the full scorecard just overwrites.
// Net score is calculated at save time from the player's course_handicap and each
// hole's stroke_index.
// Blocked if the round's requires_handicap flag is true and the player has no handicap set.
// Permission: same group member, OR organizer/admin.
func UpsertPlayerScores(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Route param + body validation first — lets Tier-1 tests reach 400 without auth context.
		roundID, err := uuid.Parse(c.Params("roundId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid round ID"})
		}
		roundPlayerID, err := uuid.Parse(c.Params("roundPlayerId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid round player ID"})
		}

		var req UpsertScoresRequest
		if err := c.BodyParser(&req); err != nil || len(req.Scores) == 0 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "scores array is required"})
		}

		userIDStr, _ := c.Locals("userID").(string)
		userRole, _ := c.Locals("userRole").(string)
		callerID, err := uuid.Parse(userIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid user ID"})
		}

		if !canModifyScores(db, roundID, roundPlayerID, callerID, userRole) {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "not authorized"})
		}

		// Load the round with its default tee holes for net-score calculation.
		var round models.Round
		if err := db.Preload("DefaultTee.Holes").Preload("Course").
			First(&round, "id = ?", roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round not found"})
		}

		// Verify the round_player belongs to this round.
		var rp models.RoundPlayer
		if err := db.First(&rp, "id = ? AND round_id = ?", roundPlayerID, roundID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "round player not found"})
		}

		// Block score entry if handicap is required but not yet set.
		if round.RequiresHandicap && rp.CourseHandicap == nil {
			return c.Status(fiber.StatusUnprocessableEntity).JSON(
				fiber.Map{"error": "handicap must be set before entering scores for this round"},
			)
		}

		// Build a lookup of stroke_index by hole_number.
		siByHole := make(map[int]int, len(round.DefaultTee.Holes))
		for _, h := range round.DefaultTee.Holes {
			siByHole[h.HoleNumber] = h.StrokeIndex
		}

		holeCount := round.Course.HoleCount
		if holeCount == 0 {
			holeCount = 18 // safe default
		}

		// Validate all hole numbers before writing anything.
		for _, s := range req.Scores {
			if s.HoleNumber < 1 || s.HoleNumber > holeCount {
				return c.Status(fiber.StatusBadRequest).JSON(
					fiber.Map{"error": "hole_number must be between 1 and course hole count"},
				)
			}
			if s.GrossScore < 1 {
				return c.Status(fiber.StatusBadRequest).JSON(
					fiber.Map{"error": "gross_score must be at least 1"},
				)
			}
		}

		// Determine the effective course handicap (0 when not set).
		chandi := 0
		if rp.CourseHandicap != nil {
			chandi = *rp.CourseHandicap
		}

		// Build Score records. Net = gross - handicap strokes for that hole.
		records := make([]models.Score, 0, len(req.Scores))
		for _, s := range req.Scores {
			si := siByHole[s.HoleNumber]
			net := s.GrossScore - HandicapStrokes(chandi, si)

			records = append(records, models.Score{
				RoundPlayerID: roundPlayerID,
				HoleNumber:    s.HoleNumber,
				GrossScore:    s.GrossScore,
				NetScore:      net,
				EnteredBy:     callerID,
			})
		}

		// Upsert: on conflict (round_player_id, hole_number) update the scores and
		// who entered them. This allows re-submitting the whole scorecard safely.
		result := db.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "round_player_id"}, {Name: "hole_number"}},
			DoUpdates: clause.AssignmentColumns([]string{"gross_score", "net_score", "entered_by"}),
		}).Create(&records)

		if result.Error != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to save scores"})
		}

		return c.JSON(fiber.Map{"saved": len(records)})
	}
}
