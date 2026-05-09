// services/handicap.go
// Pure handicap math + the cross-cutting score-recalculation routine.
//
// These live in the services package (not in any specific service struct)
// because both EventService and the future ScoreService need them: changing an
// event's handicap allowance retriggers the calc on every score in every round
// of that event. Keeping the helpers here avoids circular imports between
// services that depend on each other for a stateless arithmetic concern.
//
// PR #4 will move RecalculateEventScores onto a ScoreService; the pure
// arithmetic helpers (HandicapStrokes, EffectiveCourseHandicap) likely stay
// in this file regardless.
package services

import (
	"context"
	"fmt"
	"math"

	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
)

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

// EffectiveCourseHandicap applies the event's handicap allowance percentage to
// a player's raw course handicap.
//
//	allowance = nil  → no allowance set; full handicap.
//	allowance = 90.0 → effective = floor(raw * 0.90).
//
// floor() is USGA convention so the result is always an integer.
func EffectiveCourseHandicap(courseHandicap int, allowance *float64) int {
	if allowance == nil {
		return courseHandicap
	}
	return int(math.Floor(float64(courseHandicap) * (*allowance) / 100.0))
}

// RecalculateEventScores recomputes net_score for every scored hole across all
// rounds in an event. Triggered when an event's handicap_allowance changes.
//
// One row per (score, hole) is fetched in a single query and updated one at a
// time — coverage is comprehensive but not optimal; PR #4 may rewrite as a
// single UPDATE … FROM. Best-effort: returns the first DB error encountered.
func RecalculateEventScores(ctx context.Context, db *gorm.DB, eventID uuid.UUID, allowance *float64) error {
	type scoreRow struct {
		ScoreID        uuid.UUID
		GrossScore     int
		CourseHandicap *int
		StrokeIndex    int
	}

	var rows []scoreRow
	err := db.WithContext(ctx).Table("scores s").
		Select("s.id as score_id, s.gross_score, rp.course_handicap, h.stroke_index").
		Joins("JOIN round_players rp ON rp.id = s.round_player_id").
		Joins("JOIN rounds r ON r.id = rp.round_id").
		Joins("JOIN holes h ON h.tee_id = r.default_tee_id AND h.hole_number = s.hole_number").
		Where("r.event_id = ?", eventID).
		Scan(&rows).Error
	if err != nil {
		return fmt.Errorf("load scores for recalc: %w", err)
	}

	for _, row := range rows {
		raw := 0
		if row.CourseHandicap != nil {
			raw = *row.CourseHandicap
		}
		eff := EffectiveCourseHandicap(raw, allowance)
		netScore := row.GrossScore - HandicapStrokes(eff, row.StrokeIndex)

		if err := db.WithContext(ctx).Model(&models.Score{}).
			Where("id = ?", row.ScoreID).
			Update("net_score", netScore).Error; err != nil {
			return fmt.Errorf("update score %s: %w", row.ScoreID, err)
		}
	}
	return nil
}
