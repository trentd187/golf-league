// Package handlers contains HTTP route handler functions for the Golf League API.
// This file handles the /api/v1/users and /api/v1/me routes.
//
// Endpoints:
//
//	GET    /api/v1/me                                — return the caller's own profile (including role)
//	GET    /api/v1/users?q=                          — search users by name or email (includes is_following)
//	GET    /api/v1/users/following                   — list users the caller follows
//	GET    /api/v1/users/me/scorecard-settings       — caller's stat visibility preferences
//	PATCH  /api/v1/users/me/scorecard-settings       — update stat visibility preferences
//	GET    /api/v1/users/:userId                     — public profile for any user
//	GET    /api/v1/users/:userId/stats               — computed career stats for any user
//	POST   /api/v1/users/:userId/follow              — follow a user
//	DELETE /api/v1/users/:userId/follow              — unfollow a user
package handlers

import (
	"math"
	"sort"
	"strings"

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
	// HandicapIndex and AntiHandicap are always computed from the last 20 rounds
	// regardless of the filter param. Nil when fewer than 3 rounds have tee data.
	HandicapIndex *float64 `json:"handicap_index"`
	AntiHandicap  *float64 `json:"anti_handicap"`
}

// computeHandicapPair returns (handicapIndex, antiHandicap) from a slice of score
// differentials. Requires at least 3; returns (nil, nil) with fewer. Uses min(n, 8)
// differentials from each end of the sorted slice:
//
//	handicapIndex = avg of 8 lowest × 0.96 (WHS formula, rounded to 1 decimal)
//	antiHandicap  = avg of 8 highest       (rounded to 1 decimal)
func computeHandicapPair(diffs []float64) (handicapIndex, antiHandicap *float64) {
	n := len(diffs)
	if n < 3 {
		return nil, nil
	}
	sorted := make([]float64, n)
	copy(sorted, diffs)
	sort.Float64s(sorted)

	use := n
	if use > 8 {
		use = 8
	}

	var bestSum, worstSum float64
	for i := 0; i < use; i++ {
		bestSum += sorted[i]      // lowest differentials = best rounds
		worstSum += sorted[n-1-i] // highest differentials = worst rounds
	}

	hi := math.Round(bestSum/float64(use)*0.96*10) / 10
	ah := math.Round(worstSum/float64(use)*10) / 10
	return &hi, &ah
}

// FollowingUserResponse is one entry returned by GET /api/v1/users/following.
type FollowingUserResponse struct {
	ID           string  `json:"id"`
	DisplayName  string  `json:"display_name"`
	AvatarURL    *string `json:"avatar_url,omitempty"`
	RoundsPlayed int     `json:"rounds_played"`
}

// UserRoundRef is one entry returned by GET /api/v1/users/:userId/rounds.
// The mobile client uses round IDs to fetch scorecards in parallel and compute
// stats client-side with the same logic used on the personal stats screen.
type UserRoundRef struct {
	ID            string `json:"id"`
	ScheduledDate string `json:"scheduled_date"`
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

		// Count rounds where the round itself is completed; round_players.status is
		// never updated from "registered" today, so we join to rounds and check there.
		var roundsPlayed int64
		db.Model(&models.RoundPlayer{}).
			Joins("JOIN event_players ep ON ep.id = round_players.event_player_id").
			Joins("JOIN rounds ON rounds.id = round_players.round_id").
			Where("ep.user_id = ? AND rounds.status = ?", targetID, models.RoundStatusCompleted).
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
				Joins("JOIN rounds ON rounds.id = round_players.round_id").
				Where("ep.user_id = ? AND rounds.status = ?", u.ID, models.RoundStatusCompleted).
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
			Joins("JOIN rounds ON rounds.id = round_players.round_id").
			Where("ep.user_id = ? AND rounds.status = ?", targetID, models.RoundStatusCompleted).
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

		// Step 7: Compute handicap index and anti-handicap from the last 20 completed
		// rounds, always independent of the filter param. Each differential requires
		// course_rating and slope_rating from the tee used in that round.
		type hcRound struct {
			RoundPlayerID uuid.UUID
			CourseRating  *float64
			SlopeRating   *int
		}
		var hcRows []hcRound
		db.Raw(`
			SELECT rp.id AS round_player_id, t.course_rating, t.slope_rating
			FROM round_players rp
			JOIN event_players ep ON ep.id = rp.event_player_id
			JOIN rounds r         ON r.id  = rp.round_id
			LEFT JOIN tees t      ON t.id  = r.default_tee_id
			WHERE ep.user_id = ? AND r.status = ?
			ORDER BY rp.created_at DESC
			LIMIT 20
		`, targetID, models.RoundStatusCompleted).Scan(&hcRows)

		// Collect gross totals for these round_players. Reuse scoreRow type defined above.
		hcRPIDs := make([]uuid.UUID, 0, len(hcRows))
		hcTeeByRP := make(map[uuid.UUID]struct {
			Rating float64
			Slope  int
		})
		for _, r := range hcRows {
			if r.CourseRating != nil && r.SlopeRating != nil && *r.SlopeRating > 0 {
				hcRPIDs = append(hcRPIDs, r.RoundPlayerID)
				hcTeeByRP[r.RoundPlayerID] = struct {
					Rating float64
					Slope  int
				}{
					Rating: *r.CourseRating,
					Slope:  *r.SlopeRating,
				}
			}
		}

		var hcDiffs []float64
		if len(hcRPIDs) > 0 {
			var hcScores []scoreRow
			db.Model(&models.Score{}).
				Select("round_player_id, hole_number, gross_score").
				Where("round_player_id IN ?", hcRPIDs).
				Scan(&hcScores)

			hcTotals := make(map[uuid.UUID]int)
			for _, s := range hcScores {
				hcTotals[s.RoundPlayerID] += s.GrossScore
			}
			for rpID, gross := range hcTotals {
				if tee, ok := hcTeeByRP[rpID]; ok {
					diff := (float64(gross) - tee.Rating) * 113 / float64(tee.Slope)
					hcDiffs = append(hcDiffs, diff)
				}
			}
		}

		hcIndex, antiHC := computeHandicapPair(hcDiffs)

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
			HandicapIndex:    hcIndex,
			AntiHandicap:     antiHC,
		})
	}
}

// GetUserRounds returns a handler for GET /api/v1/users/:userId/rounds.
// Returns the last 20 completed rounds the target user participated in (id + date).
// The mobile client uses these IDs to fetch scorecards in parallel and compute
// the full stats display client-side, matching the personal stats screen exactly.
func GetUserRounds(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, _ := c.Locals("userID").(string)
		if _, err := uuid.Parse(callerIDStr); err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		targetID, err := uuid.Parse(c.Params("userId"))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid user ID"})
		}

		var results []UserRoundRef
		db.Model(&models.RoundPlayer{}).
			Select("rounds.id, rounds.scheduled_date").
			Joins("JOIN event_players ep ON ep.id = round_players.event_player_id").
			Joins("JOIN rounds ON rounds.id = round_players.round_id").
			Where("ep.user_id = ? AND rounds.status = ?", targetID, models.RoundStatusCompleted).
			Order("rounds.scheduled_date DESC").
			Limit(20).
			Scan(&results)

		if results == nil {
			results = []UserRoundRef{}
		}
		return c.JSON(results)
	}
}

// ─── Scorecard settings ───────────────────────────────────────────────────────

// defaultStatOrder is the canonical stat key sequence used when no row exists
// or when the client sends an empty stat_order array.
const defaultStatOrder = "fir,gir,putts,first_putt_distance,putt_distance_made,approach_yds,tee_shot_club,tee_shot_distance"

// defaultScorecardSettings returns an all-true row for existing stats and all-false
// for new stats, matching the database column defaults.
func defaultScorecardSettings() models.ScorecardSettings {
	return models.ScorecardSettings{
		FIREnabled:               true,
		GIREnabled:               true,
		PuttsEnabled:             true,
		FirstPuttDistanceEnabled: true,
		PuttDistanceMadeEnabled:  true,
		ApproachYdsEnabled:       true,
		TeeShotClubEnabled:       false,
		TeeShotDistanceEnabled:   false,
		StatOrder:                defaultStatOrder,
		ScorePosition:            "last",
	}
}

// ScorecardSettingsResponse is the JSON shape for GET/PATCH scorecard-settings.
// StatOrder is stored as a comma-separated string in the DB but exposed as a JSON array.
type ScorecardSettingsResponse struct {
	FIREnabled               bool     `json:"fir_enabled"`
	GIREnabled               bool     `json:"gir_enabled"`
	PuttsEnabled             bool     `json:"putts_enabled"`
	FirstPuttDistanceEnabled bool     `json:"first_putt_distance_enabled"`
	PuttDistanceMadeEnabled  bool     `json:"putt_distance_made_enabled"`
	ApproachYdsEnabled       bool     `json:"approach_yds_enabled"`
	TeeShotClubEnabled       bool     `json:"tee_shot_club_enabled"`
	TeeShotDistanceEnabled   bool     `json:"tee_shot_distance_enabled"`
	StatOrder                []string `json:"stat_order"`
	ScorePosition            string   `json:"score_position"`
}

// toSettingsResponse converts a ScorecardSettings model row to the JSON response shape.
// stat_order is stored as a comma-separated string in the DB; we split it for the client.
func toSettingsResponse(row models.ScorecardSettings) ScorecardSettingsResponse {
	order := strings.Split(row.StatOrder, ",")
	// Guard against an empty or blank column value — fall back to canonical order.
	if len(order) == 0 || (len(order) == 1 && order[0] == "") {
		order = strings.Split(defaultStatOrder, ",")
	}
	return ScorecardSettingsResponse{
		FIREnabled:               row.FIREnabled,
		GIREnabled:               row.GIREnabled,
		PuttsEnabled:             row.PuttsEnabled,
		FirstPuttDistanceEnabled: row.FirstPuttDistanceEnabled,
		PuttDistanceMadeEnabled:  row.PuttDistanceMadeEnabled,
		ApproachYdsEnabled:       row.ApproachYdsEnabled,
		TeeShotClubEnabled:       row.TeeShotClubEnabled,
		TeeShotDistanceEnabled:   row.TeeShotDistanceEnabled,
		StatOrder:                order,
		ScorePosition:            row.ScorePosition,
	}
}

// GetScorecardSettings returns a handler for GET /api/v1/users/me/scorecard-settings.
// Returns the caller's stat visibility preferences. If no row exists, returns defaults
// (existing stats enabled, new stats disabled) without creating a row.
func GetScorecardSettings(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, ok := c.Locals("userID").(string)
		if !ok || callerIDStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		var row models.ScorecardSettings
		if err := db.First(&row, "user_id = ?", callerID).Error; err != nil {
			// No row yet — return defaults without persisting anything.
			return c.JSON(toSettingsResponse(defaultScorecardSettings()))
		}

		return c.JSON(toSettingsResponse(row))
	}
}

// UpsertScorecardSettings returns a handler for PATCH /api/v1/users/me/scorecard-settings.
// Creates or replaces the caller's scorecard settings row.
func UpsertScorecardSettings(db *gorm.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		callerIDStr, ok := c.Locals("userID").(string)
		if !ok || callerIDStr == "" {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}
		callerID, err := uuid.Parse(callerIDStr)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "unauthorized"})
		}

		var body ScorecardSettingsResponse
		if err := c.BodyParser(&body); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid request body"})
		}

		// Treat omitted score_position as "last" for backward compatibility with
		// older clients that don't send the field.
		if body.ScorePosition == "" {
			body.ScorePosition = "last"
		}
		if body.ScorePosition != "first" && body.ScorePosition != "last" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "score_position must be 'first' or 'last'"})
		}
		// Fall back to canonical order when the client omits or empties stat_order.
		if len(body.StatOrder) == 0 {
			body.StatOrder = strings.Split(defaultStatOrder, ",")
		}

		row := models.ScorecardSettings{
			UserID:                   callerID,
			FIREnabled:               body.FIREnabled,
			GIREnabled:               body.GIREnabled,
			PuttsEnabled:             body.PuttsEnabled,
			FirstPuttDistanceEnabled: body.FirstPuttDistanceEnabled,
			PuttDistanceMadeEnabled:  body.PuttDistanceMadeEnabled,
			ApproachYdsEnabled:       body.ApproachYdsEnabled,
			TeeShotClubEnabled:       body.TeeShotClubEnabled,
			TeeShotDistanceEnabled:   body.TeeShotDistanceEnabled,
			StatOrder:                strings.Join(body.StatOrder, ","),
			ScorePosition:            body.ScorePosition,
		}

		// Save upserts via PK — inserts if missing, replaces if present.
		if err := db.Save(&row).Error; err != nil {
			// Store the DB error in error_detail so the HTTPMetrics middleware
			// includes it in the Loki http.error log for Grafana visibility.
			c.Locals("error_detail", "scorecard_settings.save: "+err.Error())
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "failed to save settings"})
		}

		return c.JSON(toSettingsResponse(row))
	}
}
