// services/handicap_internal_test.go
// White-box tests for unexported helpers in handicap.go.
// Uses package services (not services_test) so unexported functions are accessible.
//
// Run:
//
//	go test ./internal/services/ -run TestFilterPlayedHoles -v
package services

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/trentd187/golf-league/internal/models"
)

// ptrStr returns a pointer to a string — used to set nine_hole_selection.
func ptrStr(v string) *string { return &v }

// fullCourse returns a slice of 18 holes with consecutive hole numbers.
func fullCourse() []models.Hole {
	holes := make([]models.Hole, 18)
	for i := range holes {
		holes[i] = models.Hole{HoleNumber: i + 1}
	}
	return holes
}

// ─── filterPlayedHoles ────────────────────────────────────────────────────────

// TestFilterPlayedHoles_Nil verifies that a nil selector returns all holes unchanged.
func TestFilterPlayedHoles_Nil(t *testing.T) {
	holes := fullCourse()
	result := filterPlayedHoles(holes, nil)
	assert.Len(t, result, 18)
}

// TestFilterPlayedHoles_Front verifies that "front" returns holes 1–9 only.
func TestFilterPlayedHoles_Front(t *testing.T) {
	holes := fullCourse()
	result := filterPlayedHoles(holes, ptrStr("front"))
	assert.Len(t, result, 9)
	for _, h := range result {
		assert.LessOrEqual(t, h.HoleNumber, 9, "front should only include holes 1–9")
	}
}

// TestFilterPlayedHoles_Back verifies that "back" returns holes 10–18 only.
func TestFilterPlayedHoles_Back(t *testing.T) {
	holes := fullCourse()
	result := filterPlayedHoles(holes, ptrStr("back"))
	assert.Len(t, result, 9)
	for _, h := range result {
		assert.Greater(t, h.HoleNumber, 9, "back should only include holes 10–18")
	}
}

// TestFilterPlayedHoles_UnknownSelector verifies that an unrecognized selector
// returns an empty slice (no holes match "front" or "back" conditions).
func TestFilterPlayedHoles_UnknownSelector(t *testing.T) {
	result := filterPlayedHoles(fullCourse(), ptrStr("all"))
	assert.Empty(t, result)
}
