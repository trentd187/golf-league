// services/user_service.go
// UserService owns all user-related business logic: profile lookup, follow/unfollow,
// career stats assembly, and scorecard settings. Handlers in handlers/users.go parse
// HTTP input and delegate here; the service owns all DB access and computation.
package services

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
)

// ─── Sentinel errors ──────────────────────────────────────────────────────────

var (
	// ErrUserNotFound is declared in event_service.go (shared across the package).
	ErrFollowSelf       = errors.New("cannot follow yourself")
	ErrAlreadyFollowing = errors.New("already following")
)

// ─── Service ──────────────────────────────────────────────────────────────────

// UserService handles user profile, follow, stats, and scorecard-settings operations.
type UserService struct {
	DB *gorm.DB
}

// NewUserService constructs a UserService backed by the provided GORM connection.
func NewUserService(db *gorm.DB) *UserService {
	return &UserService{DB: db}
}

// ─── Result types ─────────────────────────────────────────────────────────────

// MeData is returned by GetMe.
type MeData struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	AvatarURL   string `json:"avatar_url,omitempty"`
	Role        string `json:"role"`
}

// UserSearchResult is one entry returned by SearchUsers.
type UserSearchResult struct {
	ID          string  `json:"id"`
	DisplayName string  `json:"display_name"`
	Email       string  `json:"email"`
	AvatarURL   *string `json:"avatar_url,omitempty"`
	IsFollowing bool    `json:"is_following"`
}

// UserProfileData is returned by GetUserProfile.
type UserProfileData struct {
	ID           string  `json:"id"`
	DisplayName  string  `json:"display_name"`
	AvatarURL    *string `json:"avatar_url,omitempty"`
	RoundsPlayed int     `json:"rounds_played"`
	EventsPlayed int     `json:"events_played"`
	IsFollowing  bool    `json:"is_following"`
	IsMe         bool    `json:"is_me"`
}

// FollowingUserData is one entry returned by GetFollowing.
type FollowingUserData struct {
	ID           string  `json:"id"`
	DisplayName  string  `json:"display_name"`
	AvatarURL    *string `json:"avatar_url,omitempty"`
	RoundsPlayed int     `json:"rounds_played"`
}

// UserRoundRef is one entry returned by GetUserRounds.
type UserRoundRef struct {
	ID            string `json:"id"`
	ScheduledDate string `json:"scheduled_date"`
}

// UserStatsData is returned by GetUserStats.
// Nil pointer fields indicate no data exists (e.g. no hole stats recorded).
type UserStatsData struct {
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
	HandicapIndex    *float64 `json:"handicap_index"`
	AntiHandicap     *float64 `json:"anti_handicap"`
}

// ScorecardSettingsData is returned by GetScorecardSettings and UpsertScorecardSettings.
// StatOrder is stored as a comma-separated string in the DB but exposed as a JSON array.
type ScorecardSettingsData struct {
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
	ShowGroupOnScorecard     bool     `json:"show_group_on_scorecard"`
}

// ScorecardSettingsInput is the PATCH body parsed by the handler and passed here.
type ScorecardSettingsInput struct {
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
	ShowGroupOnScorecard     bool     `json:"show_group_on_scorecard"`
}

// ─── Scorecard-settings helpers ───────────────────────────────────────────────

// defaultStatOrder is the canonical stat key sequence used when no row exists
// or when the client sends an empty stat_order array.
const defaultStatOrder = "fir,gir,putts,first_putt_distance,putt_distance_made,approach_yds,tee_shot_club,tee_shot_distance"

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
		ShowGroupOnScorecard:     false,
	}
}

func toSettingsData(row models.ScorecardSettings) ScorecardSettingsData {
	order := strings.Split(row.StatOrder, ",")
	if len(order) == 0 || (len(order) == 1 && order[0] == "") {
		order = strings.Split(defaultStatOrder, ",")
	}
	return ScorecardSettingsData{
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
		ShowGroupOnScorecard:     row.ShowGroupOnScorecard,
	}
}

// ─── Handicap pair ────────────────────────────────────────────────────────────

// ComputeHandicapPair returns (handicapIndex, antiHandicap) from score differentials.
// Requires at least 3 differentials; returns (nil, nil) with fewer. Uses min(n, 8)
// from each end of the sorted slice:
//
//	handicapIndex = avg of 8 lowest × 0.96 (WHS formula, rounded to 1 decimal)
//	antiHandicap  = avg of 8 highest       (rounded to 1 decimal)
func ComputeHandicapPair(diffs []float64) (handicapIndex, antiHandicap *float64) {
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
		bestSum += sorted[i]
		worstSum += sorted[n-1-i]
	}

	hi := math.Round(bestSum/float64(use)*0.96*10) / 10
	ah := math.Round(worstSum/float64(use)*10) / 10
	return &hi, &ah
}

// ─── Methods ──────────────────────────────────────────────────────────────────

// GetMe returns the authenticated caller's own profile including their platform role.
func (s *UserService) GetMe(ctx context.Context, callerID uuid.UUID) (*MeData, error) {
	var user models.User
	if err := s.DB.WithContext(ctx).First(&user, "id = ?", callerID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("user.get_me: %w", err)
	}

	avatarURL := ""
	if user.AvatarURL != nil {
		avatarURL = *user.AvatarURL
	}
	return &MeData{
		ID:          user.ID.String(),
		DisplayName: user.DisplayName,
		Email:       user.Email,
		AvatarURL:   avatarURL,
		Role:        string(user.Role),
	}, nil
}

// SearchUsers returns all users except the caller, filtered by the optional query string.
// Each result includes is_following to indicate whether the caller follows that user.
func (s *UserService) SearchUsers(ctx context.Context, callerID uuid.UUID, q string) ([]UserSearchResult, error) {
	var users []models.User
	query := s.DB.WithContext(ctx).Where("id != ?", callerID).Order("display_name ASC")
	if q != "" {
		like := "%" + q + "%"
		query = query.Where("display_name ILIKE ? OR email ILIKE ?", like, like)
	}
	query.Find(&users)

	if len(users) == 0 {
		return []UserSearchResult{}, nil
	}

	ids := make([]uuid.UUID, 0, len(users))
	for _, u := range users {
		ids = append(ids, u.ID)
	}
	var followedIDs []uuid.UUID
	s.DB.WithContext(ctx).Model(&models.Follow{}).
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
	return results, nil
}

// GetUserProfile returns a public profile: name, avatar, round/event counts, and
// whether the caller follows the target.
func (s *UserService) GetUserProfile(ctx context.Context, callerID, targetID uuid.UUID) (*UserProfileData, error) {
	var target models.User
	if err := s.DB.WithContext(ctx).First(&target, "id = ?", targetID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrUserNotFound
		}
		return nil, fmt.Errorf("user.get_profile: %w", err)
	}

	var roundsPlayed int64
	s.DB.WithContext(ctx).Model(&models.RoundPlayer{}).
		Joins("JOIN event_players ep ON ep.id = round_players.event_player_id").
		Joins("JOIN rounds ON rounds.id = round_players.round_id").
		Where("ep.user_id = ? AND rounds.status = ?", targetID, models.RoundStatusCompleted).
		Count(&roundsPlayed)

	var eventsPlayed int64
	s.DB.WithContext(ctx).Model(&models.EventPlayer{}).
		Where("user_id = ?", targetID).
		Count(&eventsPlayed)

	var followCount int64
	s.DB.WithContext(ctx).Model(&models.Follow{}).
		Where("follower_id = ? AND followee_id = ?", callerID, targetID).
		Count(&followCount)

	return &UserProfileData{
		ID:           target.ID.String(),
		DisplayName:  target.DisplayName,
		AvatarURL:    target.AvatarURL,
		RoundsPlayed: int(roundsPlayed),
		EventsPlayed: int(eventsPlayed),
		IsFollowing:  followCount > 0,
		IsMe:         callerID == targetID,
	}, nil
}

// FollowUser creates a follow relationship from caller to target.
// Returns ErrFollowSelf if caller == target, ErrAlreadyFollowing on duplicate.
func (s *UserService) FollowUser(ctx context.Context, callerID, targetID uuid.UUID) error {
	if callerID == targetID {
		return ErrFollowSelf
	}
	follow := models.Follow{FollowerID: callerID, FolloweeID: targetID}
	if err := s.DB.WithContext(ctx).Create(&follow).Error; err != nil {
		return ErrAlreadyFollowing
	}
	return nil
}

// UnfollowUser removes the follow relationship from caller to target. Idempotent.
func (s *UserService) UnfollowUser(ctx context.Context, callerID, targetID uuid.UUID) error {
	s.DB.WithContext(ctx).Delete(&models.Follow{}, "follower_id = ? AND followee_id = ?", callerID, targetID)
	return nil
}

// GetFollowing returns the list of users the caller follows, with completed-round counts.
func (s *UserService) GetFollowing(ctx context.Context, callerID uuid.UUID) ([]FollowingUserData, error) {
	var follows []models.Follow
	s.DB.WithContext(ctx).Preload("Followee").
		Where("follower_id = ?", callerID).
		Order("created_at DESC").
		Find(&follows)

	results := make([]FollowingUserData, 0, len(follows))
	for _, f := range follows {
		u := f.Followee
		var roundsPlayed int64
		s.DB.WithContext(ctx).Model(&models.RoundPlayer{}).
			Joins("JOIN event_players ep ON ep.id = round_players.event_player_id").
			Joins("JOIN rounds ON rounds.id = round_players.round_id").
			Where("ep.user_id = ? AND rounds.status = ?", u.ID, models.RoundStatusCompleted).
			Count(&roundsPlayed)

		results = append(results, FollowingUserData{
			ID:           u.ID.String(),
			DisplayName:  u.DisplayName,
			AvatarURL:    u.AvatarURL,
			RoundsPlayed: int(roundsPlayed),
		})
	}
	return results, nil
}

// GetUserStats computes career scoring stats for the target user from completed rounds.
// filter must be "all_time" or "last_20"; any other value defaults to "all_time".
func (s *UserService) GetUserStats(ctx context.Context, targetID uuid.UUID, filter string) (*UserStatsData, error) {
	if filter != "all_time" && filter != "last_20" {
		filter = "all_time"
	}

	type rpRow struct {
		ID      uuid.UUID
		RoundID uuid.UUID
	}
	rpQuery := s.DB.WithContext(ctx).Model(&models.RoundPlayer{}).
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

	empty := &UserStatsData{Filter: filter}
	if len(rpRows) == 0 {
		return empty, nil
	}

	rpIDs := make([]uuid.UUID, 0, len(rpRows))
	roundIDs := make([]uuid.UUID, 0, len(rpRows))
	for _, r := range rpRows {
		rpIDs = append(rpIDs, r.ID)
		roundIDs = append(roundIDs, r.RoundID)
	}

	type parRow struct {
		RoundID    uuid.UUID
		HoleNumber int
		Par        int
	}
	var parRows []parRow
	s.DB.WithContext(ctx).Raw(`
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

	rpToRound := make(map[uuid.UUID]uuid.UUID, len(rpRows))
	for _, r := range rpRows {
		rpToRound[r.ID] = r.RoundID
	}

	type scoreRow struct {
		RoundPlayerID uuid.UUID
		HoleNumber    int
		GrossScore    int
	}
	var scoreRows []scoreRow
	s.DB.WithContext(ctx).Model(&models.Score{}).
		Select("round_player_id, hole_number, gross_score").
		Where("round_player_id IN ?", rpIDs).
		Scan(&scoreRows)

	roundTotals := make(map[uuid.UUID]int)
	var eagles, birdies, pars, bogeys, doublePlus int

	for _, sc := range scoreRows {
		roundTotals[sc.RoundPlayerID] += sc.GrossScore

		roundID := rpToRound[sc.RoundPlayerID]
		if holeMap, ok := parMap[roundID]; ok {
			if par, ok := holeMap[sc.HoleNumber]; ok {
				diff := sc.GrossScore - par
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

	type holeStatRow struct {
		RoundPlayerID uuid.UUID
		FIR           *bool
		GIR           *string
		Putts         *int
	}
	var holeStatRows []holeStatRow
	s.DB.WithContext(ctx).Model(&models.HoleStat{}).
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

	// Handicap pair always uses the last 20 completed rounds regardless of filter.
	type hcRound struct {
		RoundPlayerID uuid.UUID
		CourseRating  *float64
		SlopeRating   *int
	}
	var hcRows []hcRound
	s.DB.WithContext(ctx).Raw(`
		SELECT rp.id AS round_player_id, t.course_rating, t.slope_rating
		FROM round_players rp
		JOIN event_players ep ON ep.id = rp.event_player_id
		JOIN rounds r         ON r.id  = rp.round_id
		LEFT JOIN tees t      ON t.id  = r.default_tee_id
		WHERE ep.user_id = ? AND r.status = ?
		ORDER BY rp.created_at DESC
		LIMIT 20
	`, targetID, models.RoundStatusCompleted).Scan(&hcRows)

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
			}{Rating: *r.CourseRating, Slope: *r.SlopeRating}
		}
	}

	var hcDiffs []float64
	if len(hcRPIDs) > 0 {
		var hcScores []scoreRow
		s.DB.WithContext(ctx).Model(&models.Score{}).
			Select("round_player_id, hole_number, gross_score").
			Where("round_player_id IN ?", hcRPIDs).
			Scan(&hcScores)

		hcTotals := make(map[uuid.UUID]int)
		for _, sc := range hcScores {
			hcTotals[sc.RoundPlayerID] += sc.GrossScore
		}
		for rpID, gross := range hcTotals {
			if tee, ok := hcTeeByRP[rpID]; ok {
				diff := (float64(gross) - tee.Rating) * 113 / float64(tee.Slope)
				hcDiffs = append(hcDiffs, diff)
			}
		}
	}

	hcIndex, antiHC := ComputeHandicapPair(hcDiffs)

	return &UserStatsData{
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
	}, nil
}

// GetUserRounds returns the last 20 completed rounds the target user participated in.
func (s *UserService) GetUserRounds(ctx context.Context, targetID uuid.UUID) ([]UserRoundRef, error) {
	var results []UserRoundRef
	s.DB.WithContext(ctx).Model(&models.RoundPlayer{}).
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
	return results, nil
}

// GetScorecardSettings returns the caller's stat visibility preferences.
// If no row exists, returns defaults without creating a row.
func (s *UserService) GetScorecardSettings(ctx context.Context, callerID uuid.UUID) (*ScorecardSettingsData, error) {
	var row models.ScorecardSettings
	if err := s.DB.WithContext(ctx).First(&row, "user_id = ?", callerID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			data := toSettingsData(defaultScorecardSettings())
			return &data, nil
		}
		return nil, fmt.Errorf("scorecard_settings.get: %w", err)
	}
	data := toSettingsData(row)
	return &data, nil
}

// UpsertScorecardSettings validates and saves the caller's scorecard settings.
// Returns ValidationError for an invalid score_position value.
func (s *UserService) UpsertScorecardSettings(ctx context.Context, callerID uuid.UUID, in ScorecardSettingsInput) (*ScorecardSettingsData, error) {
	if in.ScorePosition == "" {
		in.ScorePosition = "last"
	}
	if in.ScorePosition != "first" && in.ScorePosition != "last" {
		return nil, &ValidationError{Field: "score_position", Message: "score_position must be 'first' or 'last'"}
	}
	if len(in.StatOrder) == 0 {
		in.StatOrder = strings.Split(defaultStatOrder, ",")
	}

	statOrder := strings.Join(in.StatOrder, ",")

	// Raw SQL upsert so boolean false values are always written explicitly.
	// GORM's Create path treats false as a zero value and lets DB defaults (true)
	// win for columns tagged gorm:"default:true" — raw exec bypasses that.
	err := s.DB.WithContext(ctx).Exec(`
		INSERT INTO user_scorecard_settings
			(user_id, fir_enabled, gir_enabled, putts_enabled, first_putt_distance_enabled,
			 putt_distance_made_enabled, approach_yds_enabled, tee_shot_club_enabled,
			 tee_shot_distance_enabled, stat_order, score_position, show_group_on_scorecard)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
			fir_enabled                 = EXCLUDED.fir_enabled,
			gir_enabled                 = EXCLUDED.gir_enabled,
			putts_enabled               = EXCLUDED.putts_enabled,
			first_putt_distance_enabled = EXCLUDED.first_putt_distance_enabled,
			putt_distance_made_enabled  = EXCLUDED.putt_distance_made_enabled,
			approach_yds_enabled        = EXCLUDED.approach_yds_enabled,
			tee_shot_club_enabled       = EXCLUDED.tee_shot_club_enabled,
			tee_shot_distance_enabled   = EXCLUDED.tee_shot_distance_enabled,
			stat_order                  = EXCLUDED.stat_order,
			score_position              = EXCLUDED.score_position,
			show_group_on_scorecard     = EXCLUDED.show_group_on_scorecard
	`,
		callerID,
		in.FIREnabled, in.GIREnabled, in.PuttsEnabled, in.FirstPuttDistanceEnabled,
		in.PuttDistanceMadeEnabled, in.ApproachYdsEnabled, in.TeeShotClubEnabled,
		in.TeeShotDistanceEnabled, statOrder, in.ScorePosition, in.ShowGroupOnScorecard,
	).Error
	if err != nil {
		return nil, fmt.Errorf("scorecard_settings.save: %w", err)
	}

	data := toSettingsData(models.ScorecardSettings{
		UserID:                   callerID,
		FIREnabled:               in.FIREnabled,
		GIREnabled:               in.GIREnabled,
		PuttsEnabled:             in.PuttsEnabled,
		FirstPuttDistanceEnabled: in.FirstPuttDistanceEnabled,
		PuttDistanceMadeEnabled:  in.PuttDistanceMadeEnabled,
		ApproachYdsEnabled:       in.ApproachYdsEnabled,
		TeeShotClubEnabled:       in.TeeShotClubEnabled,
		TeeShotDistanceEnabled:   in.TeeShotDistanceEnabled,
		StatOrder:                statOrder,
		ScorePosition:            in.ScorePosition,
		ShowGroupOnScorecard:     in.ShowGroupOnScorecard,
	})
	return &data, nil
}
