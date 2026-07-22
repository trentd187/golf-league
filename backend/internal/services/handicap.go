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

// HandicapStrokes returns the strokes a player with the given course handicap
// receives (positive) or gives back (negative) on a hole identified by its
// normalized stroke_index rank. Net is always gross - strokes, so a negative
// return (a plus handicap) raises the player's net on that hole.
//
// strokeIndex must be a rank within the played set (1 = hardest hole, holeCount =
// easiest). holeCount is the number of holes being played (9 or 18).
//
// USGA allocation rule generalized: a player with handicap 5 on a 9-hole round
// gets one stroke on the 5 hardest holes (normalized SI 1–5). A player with
// handicap 20 on an 18-hole round gets two strokes on the two hardest holes and
// one stroke on the remaining 16. A PLUS handicap (negative, better than scratch)
// gives strokes back starting at the EASIEST hole (highest SI) and working down —
// the mirror of receiving. This must stay identical to the client
// holeHandicapStrokes so client-computed net matches the server.
func HandicapStrokes(courseHandicap, strokeIndex, holeCount int) int {
	if courseHandicap == 0 || strokeIndex <= 0 || holeCount <= 0 {
		return 0
	}
	if courseHandicap > 0 {
		full := courseHandicap / holeCount      // complete passes over all holes
		remainder := courseHandicap % holeCount // extra strokes from SI 1 upward
		strokes := full
		if strokeIndex <= remainder {
			strokes++
		}
		return strokes
	}
	// Plus handicap: give `give` strokes back, allocated from the easiest hole down.
	give := -courseHandicap
	full := give / holeCount
	remainder := give % holeCount // extra given strokes from the easiest hole down
	strokes := full
	if strokeIndex > holeCount-remainder {
		strokes++
	}
	return -strokes
}

// Course-handicap sanity bounds. WHS caps a Course Handicap at 54; a plus handicap
// (negative, better than scratch) rarely exceeds +10. These reject fat-fingered
// entries (e.g. "+99") that would otherwise allocate dozens of phantom strokes.
const (
	MinCourseHandicap = -10
	MaxCourseHandicap = 54
)

// validateCourseHandicap returns a *ValidationError when a course handicap is
// outside the sane WHS range. Whether an unset (nil) handicap is allowed is the
// caller's concern — this only bounds a value that is present.
func validateCourseHandicap(h int) error {
	if h < MinCourseHandicap || h > MaxCourseHandicap {
		return &ValidationError{
			Field:   "course_handicap",
			Message: fmt.Sprintf("course_handicap must be between %d and %d", MinCourseHandicap, MaxCourseHandicap),
		}
	}
	return nil
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
//
// All-or-nothing. The whole recalculation runs in ONE transaction: it rewrites net_score for
// every scored hole in the event, and a failure partway through used to leave half the event
// on the old allowance and half on the new — a silently wrong leaderboard that nothing
// repairs, because the allowance itself has already been saved and a retry sees no work to do.
// Either every score reflects the new allowance or none does.
func RecalculateEventScores(ctx context.Context, db *gorm.DB, eventID uuid.UUID, allowance *float64) error {
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var rounds []models.Round
		if err := tx.
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
			if err := tx.Table("scores s").
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

				if err := tx.Model(&models.Score{}).
					Where("id = ?", row.ScoreID).
					Update("net_score", netScore).Error; err != nil {
					return fmt.Errorf("update score %s: %w", row.ScoreID, err)
				}
			}
		}
		return nil
	})
}
