// services/handicap_test.go
// Tier 1 unit tests for HandicapStrokes, EffectiveCourseHandicap, and
// NormalizeStrokeIndexes. No DB or Docker required — pure arithmetic functions.
//
// Run:
//
//	go test ./internal/services/ -run TestHandicap -v
package services_test

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/services"
)

// ptrFloat returns a pointer to a float64 — helper for allowance arguments.
func ptrFloat(v float64) *float64 { return &v }

// ─── HandicapStrokes (18-hole) ────────────────────────────────────────────────

// TestHandicapStrokes_ZeroHandicap verifies that a scratch golfer receives no
// extra strokes on any hole.
func TestHandicapStrokes_ZeroHandicap(t *testing.T) {
	assert.Equal(t, 0, services.HandicapStrokes(0, 1, 18))
	assert.Equal(t, 0, services.HandicapStrokes(0, 18, 18))
}

// TestHandicapStrokes_FiveHandicap verifies that a 5-handicap player gets one
// stroke on holes with SI ≤ 5 and none on SI 6–18.
func TestHandicapStrokes_FiveHandicap(t *testing.T) {
	assert.Equal(t, 1, services.HandicapStrokes(5, 1, 18))
	assert.Equal(t, 1, services.HandicapStrokes(5, 5, 18))
	assert.Equal(t, 0, services.HandicapStrokes(5, 6, 18))
	assert.Equal(t, 0, services.HandicapStrokes(5, 18, 18))
}

// TestHandicapStrokes_EighteenHandicap verifies that a bogey golfer (18-handicap)
// gets exactly one stroke on every hole.
func TestHandicapStrokes_EighteenHandicap(t *testing.T) {
	for si := 1; si <= 18; si++ {
		assert.Equal(t, 1, services.HandicapStrokes(18, si, 18),
			"expected 1 stroke on hole SI=%d", si)
	}
}

// TestHandicapStrokes_TwentyHandicap verifies that handicap 20 gives two strokes
// on the two hardest holes (SI 1–2) and one stroke on the remaining 16.
func TestHandicapStrokes_TwentyHandicap(t *testing.T) {
	assert.Equal(t, 2, services.HandicapStrokes(20, 1, 18))
	assert.Equal(t, 2, services.HandicapStrokes(20, 2, 18))
	assert.Equal(t, 1, services.HandicapStrokes(20, 3, 18))
	assert.Equal(t, 1, services.HandicapStrokes(20, 18, 18))
}

// ─── HandicapStrokes (9-hole) ─────────────────────────────────────────────────

// TestHandicapStrokes_NineHole_NineHandicap verifies that a 9-hole course handicap
// of 9 gives exactly one stroke on all 9 holes.
func TestHandicapStrokes_NineHole_NineHandicap(t *testing.T) {
	for si := 1; si <= 9; si++ {
		assert.Equal(t, 1, services.HandicapStrokes(9, si, 9),
			"expected 1 stroke on normalized SI=%d", si)
	}
}

// TestHandicapStrokes_NineHole_FiveHandicap verifies strokes on SI 1–5 only.
func TestHandicapStrokes_NineHole_FiveHandicap(t *testing.T) {
	assert.Equal(t, 1, services.HandicapStrokes(5, 5, 9))
	assert.Equal(t, 0, services.HandicapStrokes(5, 6, 9))
}

// TestHandicapStrokes_NineHole_TwelveHandicap verifies that a 12-handicap on 9
// holes gets 2 strokes on the 3 hardest holes and 1 stroke on the remaining 6.
// 12/9 = 1 remainder 3 → full=1 everywhere, +1 where SI ≤ 3.
func TestHandicapStrokes_NineHole_TwelveHandicap(t *testing.T) {
	assert.Equal(t, 2, services.HandicapStrokes(12, 1, 9))
	assert.Equal(t, 2, services.HandicapStrokes(12, 3, 9))
	assert.Equal(t, 1, services.HandicapStrokes(12, 4, 9))
	assert.Equal(t, 1, services.HandicapStrokes(12, 9, 9))
}

// ─── NormalizeStrokeIndexes ───────────────────────────────────────────────────

// TestNormalizeStrokeIndexes_Front9 verifies that front-9 holes with sparse
// stroke indexes (odd 1–17) are ranked 1–9 by ascending SI so that a player's
// 9-hole handicap is allocated across all 9 holes, not just ~half of them.
func TestNormalizeStrokeIndexes_Front9(t *testing.T) {
	// Typical front 9: holes 1–9 assigned odd stroke indexes 1,3,5,7,9,11,13,15,17.
	holes := []models.Hole{
		{HoleNumber: 1, StrokeIndex: 3},
		{HoleNumber: 2, StrokeIndex: 11},
		{HoleNumber: 3, StrokeIndex: 7},
		{HoleNumber: 4, StrokeIndex: 15},
		{HoleNumber: 5, StrokeIndex: 1},
		{HoleNumber: 6, StrokeIndex: 13},
		{HoleNumber: 7, StrokeIndex: 5},
		{HoleNumber: 8, StrokeIndex: 17},
		{HoleNumber: 9, StrokeIndex: 9},
	}
	norm := services.NormalizeStrokeIndexes(holes)

	// Hole 5 has the lowest SI (1) → rank 1 (hardest).
	assert.Equal(t, 1, norm[5])
	// Hole 1 has SI 3 → rank 2.
	assert.Equal(t, 2, norm[1])
	// Hole 8 has SI 17 → rank 9 (easiest).
	assert.Equal(t, 9, norm[8])

	// All 9 holes must appear and all ranks must be 1–9.
	assert.Len(t, norm, 9)
	seen := make(map[int]bool)
	for _, v := range norm {
		seen[v] = true
	}
	for r := 1; r <= 9; r++ {
		assert.True(t, seen[r], "rank %d missing from normalized map", r)
	}
}

// TestNormalizeStrokeIndexes_Full18 verifies that a full 18-hole set with
// contiguous SIs 1–18 normalizes to the same mapping (rank == SI).
func TestNormalizeStrokeIndexes_Full18(t *testing.T) {
	holes := make([]models.Hole, 18)
	for i := range holes {
		holes[i] = models.Hole{HoleNumber: i + 1, StrokeIndex: i + 1}
	}
	norm := services.NormalizeStrokeIndexes(holes)
	for i := 1; i <= 18; i++ {
		assert.Equal(t, i, norm[i], "hole %d should have normalized SI == %d", i, i)
	}
}

// ─── EffectiveCourseHandicap ──────────────────────────────────────────────────

// TestEffectiveCourseHandicap_NilAllowance verifies that nil allowance returns
// the full course handicap unchanged.
func TestEffectiveCourseHandicap_NilAllowance(t *testing.T) {
	assert.Equal(t, 18, services.EffectiveCourseHandicap(18, nil))
	assert.Equal(t, 0, services.EffectiveCourseHandicap(0, nil))
}

// TestEffectiveCourseHandicap_100Percent verifies that 100% allowance is a no-op.
func TestEffectiveCourseHandicap_100Percent(t *testing.T) {
	assert.Equal(t, 18, services.EffectiveCourseHandicap(18, ptrFloat(100)))
}

// TestEffectiveCourseHandicap_90Percent verifies that 90% allowance floors correctly.
// 18 * 0.90 = 16.2 → floor = 16.
func TestEffectiveCourseHandicap_90Percent(t *testing.T) {
	assert.Equal(t, 16, services.EffectiveCourseHandicap(18, ptrFloat(90)))
}

// TestEffectiveCourseHandicap_75Percent verifies a common tournament allowance.
// 20 * 0.75 = 15.0 → floor = 15.
func TestEffectiveCourseHandicap_75Percent(t *testing.T) {
	assert.Equal(t, 15, services.EffectiveCourseHandicap(20, ptrFloat(75)))
}
