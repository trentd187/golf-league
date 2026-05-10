// services/handicap_test.go
// Tier 1 unit tests for HandicapStrokes and EffectiveCourseHandicap.
// No DB or Docker required — these are pure arithmetic functions.
//
// Previously in handlers/scores_test.go; moved here because they test package-
// level functions in services/handicap.go, not anything HTTP-specific.
//
// Run:
//
//	go test ./internal/services/ -run TestHandicap -v
package services_test

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/trentd187/golf-league/internal/services"
)

// ptrFloat returns a pointer to a float64 — helper for allowance arguments.
func ptrFloat(v float64) *float64 { return &v }

// ─── HandicapStrokes ──────────────────────────────────────────────────────────

// TestHandicapStrokes_ZeroHandicap verifies that a scratch golfer receives no
// extra strokes on any hole.
func TestHandicapStrokes_ZeroHandicap(t *testing.T) {
	assert.Equal(t, 0, services.HandicapStrokes(0, 1))
	assert.Equal(t, 0, services.HandicapStrokes(0, 18))
}

// TestHandicapStrokes_FiveHandicap verifies that a 5-handicap player gets one
// stroke on holes with SI ≤ 5 and none on SI 6–18.
func TestHandicapStrokes_FiveHandicap(t *testing.T) {
	assert.Equal(t, 1, services.HandicapStrokes(5, 1))
	assert.Equal(t, 1, services.HandicapStrokes(5, 5))
	assert.Equal(t, 0, services.HandicapStrokes(5, 6))
	assert.Equal(t, 0, services.HandicapStrokes(5, 18))
}

// TestHandicapStrokes_EighteenHandicap verifies that a bogey golfer (18-handicap)
// gets exactly one stroke on every hole.
func TestHandicapStrokes_EighteenHandicap(t *testing.T) {
	for si := 1; si <= 18; si++ {
		assert.Equal(t, 1, services.HandicapStrokes(18, si),
			"expected 1 stroke on hole SI=%d", si)
	}
}

// TestHandicapStrokes_TwentyHandicap verifies that handicap 20 gives two strokes
// on the two hardest holes (SI 1–2) and one stroke on the remaining 16.
func TestHandicapStrokes_TwentyHandicap(t *testing.T) {
	assert.Equal(t, 2, services.HandicapStrokes(20, 1))
	assert.Equal(t, 2, services.HandicapStrokes(20, 2))
	assert.Equal(t, 1, services.HandicapStrokes(20, 3))
	assert.Equal(t, 1, services.HandicapStrokes(20, 18))
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
