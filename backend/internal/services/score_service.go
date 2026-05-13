// services/score_service.go
// ScoreService encapsulates all score entry, handicap, hole-stat, and scorecard
// assembly operations. It owns the group-membership permission check
// (canModifyScores) and all DB work for these domains.
//
// Handlers in handlers/scores.go are thin wrappers that parse HTTP input,
// call these methods, and map the returned sentinel errors to HTTP status codes
// via writeScoreError.
package services

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ─── Sentinel errors ──────────────────────────────────────────────────────────

var (
	// ErrRoundPlayerNotFound is returned when a round_player row does not exist.
	ErrRoundPlayerNotFound = errors.New("round player not found")
	// ErrScoreForbidden is returned when the caller lacks group membership or organizer rights.
	ErrScoreForbidden = errors.New("not authorized to modify scores for this player")
	// ErrHandicapRequired is returned when requires_handicap is true but course_handicap is unset.
	ErrHandicapRequired = errors.New("handicap must be set before entering scores for this round")
	// ErrRoundCompleted is returned when a non-organizer tries to modify a completed round.
	ErrRoundCompleted = errors.New("round is completed and scores can no longer be modified")
)

// ─── Input types ──────────────────────────────────────────────────────────────

// ScoreInput is a single hole's score submitted by a client.
type ScoreInput struct {
	HoleNumber int `json:"hole_number"` // 1–18
	GrossScore int `json:"gross_score"` // total strokes taken
}

// HoleStatInput is a single hole's advanced stats submitted by a client.
type HoleStatInput struct {
	HoleNumber       int     `json:"hole_number"`
	GIR              *string `json:"gir"`                // "hit" | "miss" | "na"
	GIRMissDirection *string `json:"gir_miss_direction"` // "short" | "left" | "right" | "long"
	FIR              *bool   `json:"fir"`                // true=hit, false=miss
	FIRMissDirection *string `json:"fir_miss_direction"`
	Putts            *int    `json:"putts"`
	FirstPuttDist    *int    `json:"first_putt_distance"` // feet
	PuttDistMade     *int    `json:"putt_distance_made"`  // feet
	ApproachYds      *int    `json:"approach_yds"`        // yards
	TeeShotClub      *string `json:"tee_shot_club"`       // DR | 3W | 5W | 7W | DI | 3H
	TeeShotDistance  *int    `json:"tee_shot_distance"`   // yards
}

// ─── Result types (returned directly as JSON by scorecard handler) ────────────

// ScorecardHoleData is one hole's course data from the round's default tee.
type ScorecardHoleData struct {
	HoleNumber  int  `json:"hole_number"`
	Par         int  `json:"par"`
	StrokeIndex int  `json:"stroke_index"`
	Yardage     *int `json:"yardage"`
}

// ScorecardScoreData is one player's score on one hole.
type ScorecardScoreData struct {
	HoleNumber int `json:"hole_number"`
	GrossScore int `json:"gross_score"`
	NetScore   int `json:"net_score"`
}

// ScorecardHoleStatData holds advanced per-hole stats for one player on one hole.
type ScorecardHoleStatData struct {
	HoleNumber        int     `json:"hole_number"`
	GIR               *string `json:"gir"`
	GIRMissDirection  *string `json:"gir_miss_direction"`
	FIR               *bool   `json:"fir"`
	FIRMissDirection  *string `json:"fir_miss_direction"`
	Putts             *int    `json:"putts"`
	FirstPuttDistance *int    `json:"first_putt_distance"`
	PuttDistanceMade  *int    `json:"putt_distance_made"`
	ApproachYds       *int    `json:"approach_yds"`
	TeeShotClub       *string `json:"tee_shot_club"`
	TeeShotDistance   *int    `json:"tee_shot_distance"`
}

// ScorecardPlayerData is a player in a group with their handicap, scores, and stats.
type ScorecardPlayerData struct {
	RoundPlayerID  string  `json:"round_player_id"`
	UserID         string  `json:"user_id"`
	DisplayName    string  `json:"display_name"`
	AvatarURL      *string `json:"avatar_url"`
	CourseHandicap *int    `json:"course_handicap"`
	// EffectiveCourseHandicap is CourseHandicap after applying the event's handicap allowance.
	// Nil when CourseHandicap is nil; equals CourseHandicap when no allowance is set.
	EffectiveCourseHandicap *int                    `json:"effective_course_handicap"`
	Scores                  []ScorecardScoreData    `json:"scores"`
	HoleStats               []ScorecardHoleStatData `json:"hole_stats"`
	// TotalGross/TotalNet are nil until all holes have been scored (prevents partial totals).
	TotalGross *int `json:"total_gross"`
	TotalNet   *int `json:"total_net"`
}

// ScorecardGroupData is one tee-time group's slice of the scorecard.
type ScorecardGroupData struct {
	GroupID     string                `json:"group_id"`
	GroupNumber int                   `json:"group_number"`
	Players     []ScorecardPlayerData `json:"players"`
}

// ScorecardData is the full payload assembled by GetScorecard. Handlers return
// this directly as JSON — no additional response mapping is needed.
type ScorecardData struct {
	RoundID          string `json:"round_id"`
	RoundName        string `json:"round_name"`
	Status           string `json:"status"`
	HoleCount        int    `json:"hole_count"`
	RequiresHandicap bool   `json:"requires_handicap"`
	ScoringFormat    string `json:"scoring_format"`
	// CallerUserID is the DB UUID of the requesting user. The mobile client needs
	// this to locate its own player entry (Supabase UUID ≠ DB UUID).
	CallerUserID      string               `json:"caller_user_id"`
	IsOrganizer       bool                 `json:"is_organizer"`
	HandicapAllowance *float64             `json:"handicap_allowance"`
	NineHoleSelection *string              `json:"nine_hole_selection"`
	Holes             []ScorecardHoleData  `json:"holes"`
	Groups            []ScorecardGroupData `json:"groups"`
}

// ─── Enum validation sets ─────────────────────────────────────────────────────

// Allocated once at package init; shared across all UpsertHoleStats calls.
var (
	validGIR         = map[string]bool{"hit": true, "miss": true, "na": true}
	validMissDir     = map[string]bool{"short": true, "left": true, "right": true, "long": true}
	validTeeShotClub = map[string]bool{"DR": true, "3W": true, "5W": true, "7W": true, "DI": true, "3H": true}
)

// ─── Service ──────────────────────────────────────────────────────────────────

// ScoreService handles score entry, handicap setting, hole stats, and scorecard assembly.
type ScoreService struct {
	DB       *gorm.DB
	EventSvc *EventService
}

// NewScoreService returns a ScoreService wired to the given DB and EventService.
// EventSvc is required by canModifyScores for the organizer-bypass permission path.
func NewScoreService(db *gorm.DB, eventSvc *EventService) *ScoreService {
	return &ScoreService{DB: db, EventSvc: eventSvc}
}

// ─── Permission helper ────────────────────────────────────────────────────────

// canModifyScores returns true when callerID may enter or modify scores for
// targetRoundPlayerID. The three allowed cases:
//  1. Global admin → always allowed.
//  2. Round organizer (uses EventSvc.IsOrganizer after loading event_id from the round).
//  3. Caller is in the same tee-time group as the target player.
func (s *ScoreService) canModifyScores(ctx context.Context, roundID, targetRoundPlayerID, callerID uuid.UUID, callerRole string) (bool, error) {
	if callerRole == "admin" {
		return true, nil
	}

	var round models.Round
	if err := s.DB.WithContext(ctx).Select("event_id", "status").First(&round, "id = ?", roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, ErrRoundNotFound
		}
		return false, fmt.Errorf("load round for permission check: %w", err)
	}

	isOrg, err := s.EventSvc.IsOrganizer(ctx, round.EventID, callerID, callerRole)
	if err != nil {
		return false, fmt.Errorf("check organizer: %w", err)
	}
	if isOrg {
		return true, nil
	}

	// Non-organizers cannot modify scores on a completed round.
	if round.Status == models.RoundStatusCompleted {
		return false, ErrRoundCompleted
	}

	// Find which group the target player belongs to.
	var targetGP models.GroupPlayer
	if err := s.DB.WithContext(ctx).First(&targetGP, "round_player_id = ?", targetRoundPlayerID).Error; err != nil {
		// Target not in any group — deny without leaking why.
		return false, nil
	}

	// Resolve caller → EventPlayer → RoundPlayer → GroupPlayer.
	var callerEP models.EventPlayer
	if err := s.DB.WithContext(ctx).
		Where("event_id = ? AND user_id = ?", round.EventID, callerID).
		First(&callerEP).Error; err != nil {
		return false, nil
	}
	var callerRP models.RoundPlayer
	if err := s.DB.WithContext(ctx).
		Where("round_id = ? AND event_player_id = ?", roundID, callerEP.ID).
		First(&callerRP).Error; err != nil {
		return false, nil
	}
	var callerGP models.GroupPlayer
	err2 := s.DB.WithContext(ctx).
		Where("round_player_id = ? AND group_id = ?", callerRP.ID, targetGP.GroupID).
		First(&callerGP).Error
	return err2 == nil, nil
}

// ─── GetScorecard ─────────────────────────────────────────────────────────────

// GetScorecard assembles the full scorecard for a round. Any authenticated
// user may call this — no write permission required.
// callerID may be uuid.Nil (unauthenticated fallback) — IsOrganizer returns false in that case.
func (s *ScoreService) GetScorecard(ctx context.Context, roundID, callerID uuid.UUID, callerRole string) (*ScorecardData, error) {
	var round models.Round
	if err := s.DB.WithContext(ctx).
		Preload("DefaultTee.Holes").
		Preload("Course").
		Preload("Event").
		First(&round, "id = ?", roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrRoundNotFound
		}
		return nil, fmt.Errorf("load round: %w", err)
	}

	isOrg, err := s.EventSvc.IsOrganizer(ctx, round.EventID, callerID, callerRole)
	if err != nil {
		return nil, fmt.Errorf("check organizer: %w", err)
	}

	effectiveHoleCount := round.Course.HoleCount
	if round.NineHoleSelection != nil {
		effectiveHoleCount = 9
	}

	// Build hole list from the default tee, filtering for the selected nine.
	// Insertion sort by hole_number — GORM does not guarantee preload order.
	holeRows := make([]ScorecardHoleData, 0, len(round.DefaultTee.Holes))
	for _, h := range round.DefaultTee.Holes {
		if round.NineHoleSelection != nil {
			if *round.NineHoleSelection == "front" && h.HoleNumber > 9 {
				continue
			}
			if *round.NineHoleSelection == "back" && h.HoleNumber <= 9 {
				continue
			}
		}
		holeRows = append(holeRows, ScorecardHoleData{
			HoleNumber: h.HoleNumber, Par: h.Par,
			StrokeIndex: h.StrokeIndex, Yardage: h.Yardage,
		})
	}
	for i := 1; i < len(holeRows); i++ {
		for j := i; j > 0 && holeRows[j].HoleNumber < holeRows[j-1].HoleNumber; j-- {
			holeRows[j], holeRows[j-1] = holeRows[j-1], holeRows[j]
		}
	}

	var groups []models.Group
	if err := s.DB.WithContext(ctx).
		Where("round_id = ?", roundID).
		Order("group_number ASC").
		Find(&groups).Error; err != nil {
		return nil, fmt.Errorf("load groups: %w", err)
	}

	groupData := make([]ScorecardGroupData, 0, len(groups))
	for _, g := range groups {
		players, err := s.assembleGroupPlayers(ctx, g.ID, round.Event.HandicapAllowance, effectiveHoleCount)
		if err != nil {
			return nil, err
		}
		groupData = append(groupData, ScorecardGroupData{
			GroupID: g.ID.String(), GroupNumber: g.GroupNumber, Players: players,
		})
	}

	return &ScorecardData{
		RoundID:           round.ID.String(),
		RoundName:         round.Name,
		Status:            string(round.Status),
		HoleCount:         effectiveHoleCount,
		RequiresHandicap:  round.RequiresHandicap,
		ScoringFormat:     string(round.ScoringFormat),
		CallerUserID:      callerID.String(),
		IsOrganizer:       isOrg,
		HandicapAllowance: round.Event.HandicapAllowance,
		NineHoleSelection: round.NineHoleSelection,
		Holes:             holeRows,
		Groups:            groupData,
	}, nil
}

// assembleGroupPlayers joins group_players → round_players → event_players → users
// and loads each player's scores and hole stats.
func (s *ScoreService) assembleGroupPlayers(ctx context.Context, groupID uuid.UUID, allowance *float64, effectiveHoleCount int) ([]ScorecardPlayerData, error) {
	type playerRow struct {
		RoundPlayerID  string
		UserID         string
		DisplayName    string
		AvatarURL      *string
		CourseHandicap *int
	}
	var rows []playerRow
	if err := s.DB.WithContext(ctx).Table("group_players gp").
		Select("gp.round_player_id, u.id as user_id, u.display_name, u.avatar_url, rp.course_handicap").
		Joins("JOIN round_players rp ON rp.id = gp.round_player_id").
		Joins("JOIN event_players ep ON ep.id = rp.event_player_id").
		Joins("JOIN users u ON u.id = ep.user_id").
		Where("gp.group_id = ?", groupID).
		Scan(&rows).Error; err != nil {
		return nil, fmt.Errorf("load group players: %w", err)
	}

	players := make([]ScorecardPlayerData, 0, len(rows))
	for _, pr := range rows {
		rpID, _ := uuid.Parse(pr.RoundPlayerID)

		var dbScores []models.Score
		if err := s.DB.WithContext(ctx).
			Where("round_player_id = ?", rpID).
			Order("hole_number ASC").
			Find(&dbScores).Error; err != nil {
			return nil, fmt.Errorf("load scores for player %s: %w", rpID, err)
		}

		scores := make([]ScorecardScoreData, 0, len(dbScores))
		totalGross, totalNet := 0, 0
		for _, sc := range dbScores {
			scores = append(scores, ScorecardScoreData{
				HoleNumber: sc.HoleNumber, GrossScore: sc.GrossScore, NetScore: sc.NetScore,
			})
			totalGross += sc.GrossScore
			totalNet += sc.NetScore
		}
		var tg, tn *int
		if len(dbScores) >= effectiveHoleCount {
			tg, tn = &totalGross, &totalNet
		}

		var dbStats []models.HoleStat
		if err := s.DB.WithContext(ctx).
			Where("round_player_id = ?", rpID).
			Order("hole_number ASC").
			Find(&dbStats).Error; err != nil {
			return nil, fmt.Errorf("load stats for player %s: %w", rpID, err)
		}

		holeStats := make([]ScorecardHoleStatData, 0, len(dbStats))
		for _, st := range dbStats {
			holeStats = append(holeStats, ScorecardHoleStatData{
				HoleNumber: st.HoleNumber, GIR: st.GIR, GIRMissDirection: st.GIRMissDirection,
				FIR: st.FIR, FIRMissDirection: st.FIRMissDirection, Putts: st.Putts,
				FirstPuttDistance: st.FirstPuttDistance, PuttDistanceMade: st.PuttDistanceMade,
				ApproachYds: st.ApproachYds, TeeShotClub: st.TeeShotClub, TeeShotDistance: st.TeeShotDistance,
			})
		}

		var effHCP *int
		if pr.CourseHandicap != nil {
			eff := EffectiveCourseHandicap(*pr.CourseHandicap, allowance)
			effHCP = &eff
		}

		players = append(players, ScorecardPlayerData{
			RoundPlayerID: pr.RoundPlayerID, UserID: pr.UserID, DisplayName: pr.DisplayName,
			AvatarURL: pr.AvatarURL, CourseHandicap: pr.CourseHandicap,
			EffectiveCourseHandicap: effHCP, Scores: scores, HoleStats: holeStats,
			TotalGross: tg, TotalNet: tn,
		})
	}
	return players, nil
}

// ─── SetHandicap ──────────────────────────────────────────────────────────────

// SetHandicap sets the playing handicap (course_handicap) for a single round_player.
// Caller must share a tee-time group with the target player, or be an organizer/admin.
func (s *ScoreService) SetHandicap(ctx context.Context, roundID, roundPlayerID, callerID uuid.UUID, callerRole string, handicap int) error {
	ok, err := s.canModifyScores(ctx, roundID, roundPlayerID, callerID, callerRole)
	if err != nil {
		return err
	}
	if !ok {
		return ErrScoreForbidden
	}

	var rp models.RoundPlayer
	if err := s.DB.WithContext(ctx).First(&rp, "id = ? AND round_id = ?", roundPlayerID, roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrRoundPlayerNotFound
		}
		return fmt.Errorf("load round player: %w", err)
	}

	rp.CourseHandicap = &handicap
	if err := s.DB.WithContext(ctx).Save(&rp).Error; err != nil {
		return fmt.Errorf("save handicap: %w", err)
	}
	return nil
}

// ─── UpsertScores ─────────────────────────────────────────────────────────────

// UpsertScores bulk-upserts all hole scores for one player. Idempotent — safe
// to call multiple times (ON CONFLICT DO UPDATE per hole).
// Net score is calculated at save time from course_handicap and stroke_index.
// Blocked when requires_handicap is true and course_handicap is not yet set.
func (s *ScoreService) UpsertScores(ctx context.Context, roundID, roundPlayerID, callerID uuid.UUID, callerRole string, scores []ScoreInput) (int, error) {
	ok, err := s.canModifyScores(ctx, roundID, roundPlayerID, callerID, callerRole)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, ErrScoreForbidden
	}

	var round models.Round
	if err := s.DB.WithContext(ctx).
		Preload("DefaultTee.Holes").Preload("Course").Preload("Event").
		First(&round, "id = ?", roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, ErrRoundNotFound
		}
		return 0, fmt.Errorf("load round: %w", err)
	}

	var rp models.RoundPlayer
	if err := s.DB.WithContext(ctx).First(&rp, "id = ? AND round_id = ?", roundPlayerID, roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, ErrRoundPlayerNotFound
		}
		return 0, fmt.Errorf("load round player: %w", err)
	}

	if round.RequiresHandicap && rp.CourseHandicap == nil {
		return 0, ErrHandicapRequired
	}

	siByHole := make(map[int]int, len(round.DefaultTee.Holes))
	for _, h := range round.DefaultTee.Holes {
		siByHole[h.HoleNumber] = h.StrokeIndex
	}
	holeCount := round.Course.HoleCount
	if holeCount == 0 {
		holeCount = 18
	}

	for _, sc := range scores {
		if sc.HoleNumber < 1 || sc.HoleNumber > holeCount {
			return 0, &ValidationError{Field: "hole_number", Message: "hole_number must be between 1 and course hole count"}
		}
		if sc.GrossScore < 1 {
			return 0, &ValidationError{Field: "gross_score", Message: "gross_score must be at least 1"}
		}
	}

	rawHandicap := 0
	if rp.CourseHandicap != nil {
		rawHandicap = *rp.CourseHandicap
	}
	chandi := EffectiveCourseHandicap(rawHandicap, round.Event.HandicapAllowance)

	records := make([]models.Score, 0, len(scores))
	for _, sc := range scores {
		si := siByHole[sc.HoleNumber]
		records = append(records, models.Score{
			RoundPlayerID: roundPlayerID,
			HoleNumber:    sc.HoleNumber,
			GrossScore:    sc.GrossScore,
			NetScore:      sc.GrossScore - HandicapStrokes(chandi, si),
			EnteredBy:     callerID,
		})
	}

	result := s.DB.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "round_player_id"}, {Name: "hole_number"}},
		DoUpdates: clause.AssignmentColumns([]string{"gross_score", "net_score", "entered_by"}),
	}).Create(&records)
	if result.Error != nil {
		return 0, fmt.Errorf("upsert scores: %w", result.Error)
	}
	return len(records), nil
}

// ─── UpsertHoleStats ──────────────────────────────────────────────────────────

// UpsertHoleStats bulk-upserts advanced per-hole stats for one player. Idempotent.
// Enum validation runs first (before the DB permission check) so Tier 1 handler
// tests can reach the validation error path via nilScoreSvc() with auth injected.
func (s *ScoreService) UpsertHoleStats(ctx context.Context, roundID, roundPlayerID, callerID uuid.UUID, callerRole string, stats []HoleStatInput) (int, error) {
	for _, st := range stats {
		if st.GIR != nil && !validGIR[*st.GIR] {
			return 0, &ValidationError{Field: "gir", Message: "gir must be one of: hit, miss, na"}
		}
		if st.GIRMissDirection != nil && !validMissDir[*st.GIRMissDirection] {
			return 0, &ValidationError{Field: "gir_miss_direction", Message: "gir_miss_direction must be one of: short, left, right, long"}
		}
		if st.FIRMissDirection != nil && !validMissDir[*st.FIRMissDirection] {
			return 0, &ValidationError{Field: "fir_miss_direction", Message: "fir_miss_direction must be one of: short, left, right, long"}
		}
		if st.TeeShotClub != nil && !validTeeShotClub[*st.TeeShotClub] {
			return 0, &ValidationError{Field: "tee_shot_club", Message: "tee_shot_club must be one of: DR, 3W, 5W, 7W, DI, 3H"}
		}
	}

	ok, err := s.canModifyScores(ctx, roundID, roundPlayerID, callerID, callerRole)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, ErrScoreForbidden
	}

	var rp models.RoundPlayer
	if err := s.DB.WithContext(ctx).First(&rp, "id = ? AND round_id = ?", roundPlayerID, roundID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 0, ErrRoundPlayerNotFound
		}
		return 0, fmt.Errorf("load round player: %w", err)
	}

	records := make([]models.HoleStat, 0, len(stats))
	for _, st := range stats {
		records = append(records, models.HoleStat{
			RoundPlayerID:     roundPlayerID,
			HoleNumber:        st.HoleNumber,
			GIR:               st.GIR,
			GIRMissDirection:  st.GIRMissDirection,
			FIR:               st.FIR,
			FIRMissDirection:  st.FIRMissDirection,
			Putts:             st.Putts,
			FirstPuttDistance: st.FirstPuttDist,
			PuttDistanceMade:  st.PuttDistMade,
			ApproachYds:       st.ApproachYds,
			TeeShotClub:       st.TeeShotClub,
			TeeShotDistance:   st.TeeShotDistance,
		})
	}

	result := s.DB.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "round_player_id"}, {Name: "hole_number"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"gir", "gir_miss_direction",
			"fir", "fir_miss_direction",
			"putts", "first_putt_distance", "putt_distance_made", "approach_yds",
			"tee_shot_club", "tee_shot_distance",
			"updated_at",
		}),
	}).Create(&records)
	if result.Error != nil {
		return 0, fmt.Errorf("upsert hole stats: %w", result.Error)
	}
	return len(records), nil
}
