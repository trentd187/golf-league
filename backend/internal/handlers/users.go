// Package handlers contains HTTP route handler functions for the Golf League API.
// This file handles the /api/v1/users and /api/v1/me routes.
//
// Endpoints:
//
//	GET    /api/v1/me                    — return the caller's own profile (including role)
//	GET    /api/v1/users?q=              — search users by name or email (includes is_following)
//	GET    /api/v1/users/following       — list users the caller follows
//	GET    /api/v1/users/:userId         — public profile for any user
//	GET    /api/v1/users/:userId/stats   — computed career stats for any user
//	POST   /api/v1/users/:userId/follow  — follow a user
//	DELETE /api/v1/users/:userId/follow  — unfollow a user
package handlers

import (
	"math"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
)

// MeResponse is the shape returned by GET /api/v1/me.
// Includes the role field which lives only in our DB (not in the Supabase JWT).
type MeResponse struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	Role        string `json:"role"`
}

// GetMe returns a handler for GET /api/v1/me.
// Returns the authenticated caller's own profile including their platform role.
func GetMe(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, ok := c.Locals("userID").(string)
		if !ok || callerIDStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Unauthorized"})
		}

		var user models.User
		if err := db.First(&user, "id = ?", callerIDStr).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "User not found"})
		}

		avatarURL := ""
		if user.AvatarURL != nil {
			avatarURL = *user.AvatarURL
		}

		return c.JSON(MeResponse{
			ID:          user.ID.String(),
			DisplayName: user.DisplayName,
			Email:       user.Email,
			AvatarURL:   avatarURL,
			Role:        string(user.Role),
		})
	}
}

// UserSummaryResponse is the trimmed-down user shape used by internal pickers (e.g. Add Member).
type UserSummaryResponse struct {
	ID          string  `json:"id"`
	DisplayName string  `json:"display_name"`
	Email       string  `json:"email"`
	AvatarURL   *string `json:"avatar_url,omitempty"`
}

// UserSearchResult is returned by GET /api/v1/users?q=.
// is_following indicates whether the authenticated caller follows this user.
type UserSearchResult struct {
	ID          string  `json:"id"`
	DisplayName string  `json:"display_name"`
	Email       string  `json:"email"`
	AvatarURL   *string `json:"avatar_url,omitempty"`
	IsFollowing bool    `json:"is_following"`
}

// UserProfileResponse is returned by GET /api/v1/users/:userId.
type UserProfileResponse struct {
	ID           string  `json:"id"`
	DisplayName  string  `json:"display_name"`
	AvatarURL    *string `json:"avatar_url,omitempty"`
	RoundsPlayed int     `json:"rounds_played"`
	EventsPlayed int     `json:"events_played"`
	IsFollowing  bool    `json:"is_following"`
	IsMe         bool    `json:"is_me"`
}

// UserStatsResponse is returned by GET /api/v1/users/:userId/stats.
// Nil pointer fields indicate no data exists (e.g. no hole stats recorded).
type UserStatsResponse struct {
	AvgGrossPerRound *float64 `json:"avg_gross_per_round"`
	LowRound         *int     `json:"low_round"`
	HighRound        *int     `json:"high_round"`
	Eagles           int      `json:"eagles"`
	Birdies          int      `json:"birdies"`
	Pars             int      `json:"pars"`
	Bogeys           int      `json:"bogeys"`
	DoublePlus       int      `json:"double_plus"`
	FIRPct           *float64 `json:"fir_pct"`
	GIRPct           *float64 `json:"gir_pct"`
	AvgPutts         *float64 `json:"avg_putts_per_round"`
	RoundsCounted    int      `json:"rounds_counted"`
	Filter           string   `json:"filter"`
}

// FollowingUserResponse is one entry returned by GET /api/v1/users/following.
type FollowingUserResponse struct {
	ID           string  `json:"id"`
	DisplayName  string  `json:"display_name"`
	AvatarURL    *string `json:"avatar_url,omitempty"`
	RoundsPlayed int     `json:"rounds_played"`
}

// SearchUsers returns a handler for GET /api/v1/users?q=.
// Returns all users except the caller, filtered by ?q= (optional name/email prefix search).
// Each result includes is_following to indicate whether the caller follows that user.
func SearchUsers(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		q := c.Query("q")

		var users []models.User
		query := db.Where("id != ?", callerID).Order("display_name ASC")
		if q != "" {
			like := "%" + q + "%"
			query = query.Where("display_name ILIKE ? OR email ILIKE ?", like, like)
		}
		query.Find(&users)

		if len(users) == 0 {
			return c.JSON([]UserSearchResult{})
		}

		// Batch-check which of these users the caller already follows to avoid N+1.
		ids := make([]uuid.UUID, 0, len(users))
		for _, u := range users {
			ids = append(ids, u.ID)
		}
		var followedIDs []uuid.UUID
		db.Model(&models.Follow{}).
			Where("follower_id = ? AND followee_id IN ?", callerID, ids).
			Pluck("followee_id", &followedIDs)

		followSet := make(map[uuid.UUID]bool, len(followedIDs))
		for _, fid := range followedIDs {
			followSet[fid] = true
		}

		results := make([]UserSearchResult, 0, len(users))
		for _, u := range users {
			results = append(results, UserSearchResult{
				ID:          u.ID.String(),
				DisplayName: u.DisplayName,
				Email:       u.Email,
				AvatarURL:   u.AvatarURL,
				IsFollowing: followSet[u.ID],
			})
		}

		return c.JSON(results)
	}
}

// GetUserProfile returns a handler for GET /api/v1/users/:userId.
// Returns a public profile: name, avatar, round/event counts, and whether the caller follows them.
func GetUserProfile(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		targetID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		var target models.User
		if err := db.First(&target, "id = ?", targetID).Error; err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "user not found"})
		}

		// Count completed round_player rows via the event_player join.
		var roundsPlayed int64
		db.Model(&models.RoundPlayer{}).
			Joins("JOIN event_players ep ON ep.id = round_players.event_player_id").
			Where("ep.user_id = ? AND round_players.status = ?", targetID, models.RoundPlayerStatusCompleted).
			Count(&roundsPlayed)

		var eventsPlayed int64
		db.Model(&models.EventPlayer{}).
			Where("user_id = ?", targetID).
			Count(&eventsPlayed)

		var followCount int64
		db.Model(&models.Follow{}).
			Where("follower_id = ? AND followee_id = ?", callerID, targetID).
			Count(&followCount)

		return c.JSON(UserProfileResponse{
			ID:           target.ID.String(),
			DisplayName:  target.DisplayName,
			AvatarURL:    target.AvatarURL,
			RoundsPlayed: int(roundsPlayed),
			EventsPlayed: int(eventsPlayed),
			IsFollowing:  followCount > 0,
			IsMe:         callerID == targetID,
		})
	}
}

// FollowUser returns a handler for POST /api/v1/users/:userId/follow.
// Creates a follow relationship from the caller to the target user.
// Returns 409 if already following, 400 if the caller tries to follow themselves.
func FollowUser(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		targetID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		if callerID == targetID {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "cannot follow yourself"})
		}

		follow := models.Follow{FollowerID: callerID, FolloweeID: targetID}
		result := db.Create(&follow)
		if result.Error != nil {
			// Duplicate primary key = already following.
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "already following"})
		}

		return c.Status(fiber.StatusOK).JSON(fiber.Map{"ok": true})
	}
}

// UnfollowUser returns a handler for DELETE /api/v1/users/:userId/follow.
// Removes the follow relationship from caller to target. Idempotent (204 even if not following).
func UnfollowUser(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		targetID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		db.Delete(&models.Follow{}, "follower_id = ? AND followee_id = ?", callerID, targetID)

		return c.SendStatus(fiber.StatusNoContent)
	}
}

// GetFollowing returns a handler for GET /api/v1/users/following.
// Returns the list of users the caller currently follows, with round counts.
func GetFollowing(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		var follows []models.Follow
		db.Preload("Followee").
			Where("follower_id = ?", callerID).
			Order("created_at DESC").
			Find(&follows)

		results := make([]FollowingUserResponse, 0, len(follows))
		for _, f := range follows {
			u := f.Followee

			var roundsPlayed int64
			db.Model(&models.RoundPlayer{}).
				Joins("JOIN event_players ep ON ep.id = round_players.event_player_id").
				Where("ep.user_id = ? AND round_players.status = ?", u.ID, models.RoundPlayerStatusCompleted).
				Count(&roundsPlayed)

			results = append(results, FollowingUserResponse{
				ID:           u.ID.String(),
				DisplayName:  u.DisplayName,
				AvatarURL:    u.AvatarURL,
				RoundsPlayed: int(roundsPlayed),
			})
		}

		return c.JSON(results)
	}
}

// GetUserStats returns a handler for GET /api/v1/users/:userId/stats?filter=all_time|last_20.
// Computes career scoring stats for the target user from completed rounds.
// Stats are public to any authenticated user.
func GetUserStats(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		_, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		targetID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		filter := c.Query("filter", "all_time")
		if filter != "all_time" && filter != "last_20" {
			filter = "all_time"
		}

		// Step 1: Fetch completed round_player rows for the target user.
		type rpRow struct {
			ID      uuid.UUID
			RoundID uuid.UUID
		}
		rpQuery := db.Model(&models.RoundPlayer{}).
			Select("round_players.id, round_players.round_id").
			Joins("JOIN event_players ep ON ep.id = round_players.event_player_id").
			Where("ep.user_id = ? AND round_players.status = ?", targetID, models.RoundPlayerStatusCompleted).
			Order("round_players.created_at DESC")
		if filter == "last_20" {
			rpQuery = rpQuery.Limit(20)
		}
		var rpRows []rpRow
		rpQuery.Scan(&rpRows)

		empty := UserStatsResponse{Filter: filter}
		if len(rpRows) == 0 {
			return c.JSON(empty)
		}

		rpIDs := make([]uuid.UUID, 0, len(rpRows))
		roundIDs := make([]uuid.UUID, 0, len(rpRows))
		for _, r := range rpRows {
			rpIDs = append(rpIDs, r.ID)
			roundIDs = append(roundIDs, r.RoundID)
		}

		// Step 2: Build a map of round_id → hole_number → par in one query.
		type parRow struct {
			RoundID    uuid.UUID
			HoleNumber int
			Par        int
		}
		var parRows []parRow
		db.Raw(`
			SELECT r.id AS round_id, h.hole_number, h.par
			FROM rounds r
			JOIN holes h ON h.tee_id = r.default_tee_id
			WHERE r.id IN ?
		`, roundIDs).Scan(&parRows)

		parMap := make(map[uuid.UUID]map[int]int)
		for _, p := range parRows {
			if parMap[p.RoundID] == nil {
				parMap[p.RoundID] = make(map[int]int)
			}
			parMap[p.RoundID][p.HoleNumber] = p.Par
		}

		// Build round_player_id → round_id for par lookups per score.
		rpToRound := make(map[uuid.UUID]uuid.UUID, len(rpRows))
		for _, r := range rpRows {
			rpToRound[r.ID] = r.RoundID
		}

		// Step 3: Load all scores for these round_players.
		type scoreRow struct {
			RoundPlayerID uuid.UUID
			HoleNumber    int
			GrossScore    int
		}
		var scoreRows []scoreRow
		db.Model(&models.Score{}).
			Select("round_player_id, hole_number, gross_score").
			Where("round_player_id IN ?", rpIDs).
			Scan(&scoreRows)

		// Step 4: Compute per-round totals and par-type breakdown.
		roundTotals := make(map[uuid.UUID]int) // round_player_id → gross total
		var eagles, birdies, pars, bogeys, doublePlus int

		for _, s := range scoreRows {
			roundTotals[s.RoundPlayerID] += s.GrossScore

			roundID := rpToRound[s.RoundPlayerID]
			if holeMap, ok := parMap[roundID]; ok {
				if par, ok := holeMap[s.HoleNumber]; ok {
					diff := s.GrossScore - par
					switch {
					case diff <= -2:
						eagles++
					case diff == -1:
						birdies++
					case diff == 0:
						pars++
					case diff == 1:
						bogeys++
					default:
						doublePlus++
					}
				}
			}
		}

		// Step 5: Compute avg/low/high from per-round totals.
		var totalGross int
		var lowRound, highRound *int
		for _, gross := range roundTotals {
			totalGross += gross
			if lowRound == nil || gross < *lowRound {
				v := gross
				lowRound = &v
			}
			if highRound == nil || gross > *highRound {
				v := gross
				highRound = &v
			}
		}
		roundCount := len(roundTotals)
		var avgGross *float64
		if roundCount > 0 {
			v := math.Round(float64(totalGross)/float64(roundCount)*100) / 100
			avgGross = &v
		}

		// Step 6: Load hole stats for FIR / GIR / putts.
		type holeStatRow struct {
			RoundPlayerID uuid.UUID
			FIR           *bool
			GIR           *string
			Putts         *int
		}
		var holeStatRows []holeStatRow
		db.Model(&models.HoleStat{}).
			Select("round_player_id, fir, gir, putts").
			Where("round_player_id IN ?", rpIDs).
			Scan(&holeStatRows)

		var firApplicable, firHit int
		var girApplicable, girHit int
		puttsByRP := make(map[uuid.UUID]int)
		rpsWithPutts := make(map[uuid.UUID]bool)

		for _, hs := range holeStatRows {
			if hs.FIR != nil {
				firApplicable++
				if *hs.FIR {
					firHit++
				}
			}
			if hs.GIR != nil && *hs.GIR != "na" {
				girApplicable++
				if *hs.GIR == "hit" {
					girHit++
				}
			}
			if hs.Putts != nil {
				puttsByRP[hs.RoundPlayerID] += *hs.Putts
				rpsWithPutts[hs.RoundPlayerID] = true
			}
		}

		var firPct, girPct, avgPutts *float64
		if firApplicable > 0 {
			v := math.Round(float64(firHit)/float64(firApplicable)*1000) / 10
			firPct = &v
		}
		if girApplicable > 0 {
			v := math.Round(float64(girHit)/float64(girApplicable)*1000) / 10
			girPct = &v
		}
		if len(rpsWithPutts) > 0 {
			var totalPutts int
			for _, p := range puttsByRP {
				totalPutts += p
			}
			v := math.Round(float64(totalPutts)/float64(len(rpsWithPutts))*100) / 100
			avgPutts = &v
		}

		return c.JSON(UserStatsResponse{
			AvgGrossPerRound: avgGross,
			LowRound:         lowRound,
			HighRound:        highRound,
			Eagles:           eagles,
			Birdies:          birdies,
			Pars:             pars,
			Bogeys:           bogeys,
			DoublePlus:       doublePlus,
			FIRPct:           firPct,
			GIRPct:           girPct,
			AvgPutts:         avgPutts,
			RoundsCounted:    roundCount,
			Filter:           filter,
		})
	}
}
