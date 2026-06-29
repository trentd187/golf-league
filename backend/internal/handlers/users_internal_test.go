// users_internal_test.go holds white-box (package handlers) unit tests for unexported
// helpers in users.go that don't warrant widening the package API just to be tested.
package handlers

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestClampUserScorecardsLast pins the ?last= bounds: < 1 floors to 1, anything over the
// max ceils to maxUserScorecards, valid values pass through. This is the guard that lets
// the stats screen request its full history without enabling an unbounded batch.
func TestClampUserScorecardsLast(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{in: 0, want: 1},
		{in: -5, want: 1},
		{in: 1, want: 1},
		{in: 20, want: 20},
		{in: maxUserScorecards, want: maxUserScorecards},
		{in: maxUserScorecards + 1, want: maxUserScorecards},
		{in: 100000, want: maxUserScorecards},
	}
	for _, tc := range cases {
		assert.Equal(t, tc.want, clampUserScorecardsLast(tc.in), "last=%d", tc.in)
	}
}
