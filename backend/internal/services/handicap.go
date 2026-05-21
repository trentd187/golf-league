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
	"sort"

	"github.com/google/uuid"
	"github.com/trentd187/golf-league/internal/models"
	"gorm.io/gorm"
)

// HandicapStrokes returns the number of strokes a player with the given course
// handicap receives on a hole identified by its normalized stroke_index rank.
//
// strokeIndex must be a rank within the played set (1 = hardest hole, holeCount =
// easiest). holeCount is the number of holes being played (9 or 18).
//
// USGA allocation rule generalized: a player with handicap 5 on a 9-hole round
// gets one stroke on the 5 hardest holes (normalized SI 1–5). A player with
// handicap 20 on an 18-hole round gets two strokes on the two hardest holes and
// one stroke on the remaining 16.
func HandicapStrokes(courseHandicap, strokeIndex, holeCount int) int {
	if courseHandicap <= 0 || strokeIndex <= 0 || holeCount <= 0 {
		return 0
	}
	full := courseHandicap / holeCount      // complete passes over all holes
	remainder := courseHandicap % holeCount // extra strokes from SI 1 upward
	strokes := full
	if strokeIndex <= remainder {
		strokes++
	}
	return strokes
}

// NormalizeStrokeIndexes returns a map from hole_number → normalized rank (1 = hardest).
// Holes are ranked by ascending stroke_index so handicap allocation works correctly
// when playing a subset of holes (e.g. front or back 9 of an 18-hole course whose
// raw stroke indexes span 1–18 with gaps).
func NormalizeStrokeIndexes(holes []models.Hole) map[int]int {
	type entry struct{ holeNumber, si int }
	entries := make([]entry, 0, len(holes))
	for _, h := range holes {
		entries = append(entries, entry{h.HoleNumber, h.StrokeIndex})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].si < entries[j].si })
	m := make(map[int]int, len(entries))
	for rank, e := range entries {
		m[e.holeNumber] = rank + 1
	}
	return m
}

// filterPlayedHoles returns the subset of holes being played for a round.
// nil selection → all holes; "front" → holes 1–9; "back" → holes 10–18.
func filterPlayedHoles(holes []models.Hole, sel *string) []models.Hole {
	if sel == nil {
		return holes
	}
	result := make([]models.Hole, 0, 9)
	for _, h := range holes {
		if *sel == "front" && h.HoleNumber <= 9 {
			result = append(result, h)
		} else if *sel == "back" && h.HoleNumber > 9 {
			result = append(result, h)
		}
	}
	return result
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
// Processes per-round so each round's nine_hole_selection can be used to
// normalize stroke indexes before applying HandicapStrokes.
// Best-effort: returns the first DB error encountered.
func RecalculateEventScores(ctx context.Context, db *gorm.DB, eventID uuid.UUID, allowance *float64) error {
	var rounds []models.Round
	if err := db.WithContext(ctx).
		Preload("DefaultTee.Holes").
		Where("event_id = ?", eventID).
		Find(&rounds).Error; err != nil {
		return fmt.Errorf("load rounds for recalc: %w", err)
	}

	type scoreRow struct {
		ScoreID        uuid.UUID
		GrossScore     int
		HoleNumber     int
		CourseHandicap *int
	}

	for _, round := range rounds {
		played := filterPlayedHoles(round.DefaultTee.Holes, round.NineHoleSelection)
		if len(played) == 0 {
			continue
		}
		siMap := NormalizeStrokeIndexes(played)
		holeCount := len(played)

		var rows []scoreRow
		if err := db.WithContext(ctx).Table("scores s").
			Select("s.id as score_id, s.gross_score, s.hole_number, rp.course_handicap").
			Joins("JOIN round_players rp ON rp.id = s.round_player_id").
			Where("rp.round_id = ?", round.ID).
			Scan(&rows).Error; err != nil {
			return fmt.Errorf("load scores for round %s: %w", round.ID, err)
		}

		for _, row := range rows {
			raw := 0
			if row.CourseHandicap != nil {
				raw = *row.CourseHandicap
			}
			eff := EffectiveCourseHandicap(raw, allowance)
			netScore := row.GrossScore - HandicapStrokes(eff, siMap[row.HoleNumber], holeCount)

			if err := db.WithContext(ctx).Model(&models.Score{}).
				Where("id = ?", row.ScoreID).
				Update("net_score", netScore).Error; err != nil {
				return fmt.Errorf("update score %s: %w", row.ScoreID, err)
			}
		}
	}
	return nil
}
