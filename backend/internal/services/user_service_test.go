// services/user_service_test.go
// Integration tests for UserService. Uses testutil.NewTestDB to spin up an
// ephemeral Postgres container — Docker must be running.
//
// Also contains Tier 1 unit tests for ComputeHandicapPair (pure function, no DB).
// Previously in handlers/users_test.go via ComputeHandicapPairExported; moved here
// because they test a service-level function, not HTTP plumbing.
//
// Do NOT call t.Parallel() — TRUNCATE is global across the shared container.
//
// Run:
//
//	go test -count=1 -timeout 300s ./internal/services/ -run "TestUserService|TestComputeHandicap" -v
package services_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/services"
	"github.com/trentd187/golf-league/internal/testutil"
)

// ─── ComputeHandicapPair (Tier 1 — no DB) ────────────────────────────────────

func TestComputeHandicapPair_NilSlice(t *testing.T) {
	hi, ah := services.ComputeHandicapPair(nil)
	assert.Nil(t, hi)
	assert.Nil(t, ah)
}

func TestComputeHandicapPair_TwoRounds(t *testing.T) {
	hi, ah := services.ComputeHandicapPair([]float64{10.0, 12.0})
	assert.Nil(t, hi)
	assert.Nil(t, ah)
}

// TestComputeHandicapPair_ThreeRounds verifies exactly 3 differentials (the minimum)
// produces results using all 3 for both hi and ah.
func TestComputeHandicapPair_ThreeRounds(t *testing.T) {
	// diffs sorted: [8, 12, 16]. use=3 (all three for both ends).
	hi, ah := services.ComputeHandicapPair([]float64{16.0, 8.0, 12.0})
	require.NotNil(t, hi)
	require.NotNil(t, ah)
	// avg = (8+12+16)/3 = 12.0; hi = 12.0×0.96 = 11.52 → 11.5
	assert.Equal(t, 11.5, *hi)
	// ah = same avg 12.0 → 12.0
	assert.Equal(t, 12.0, *ah)
}

// TestComputeHandicapPair_EightRounds verifies exactly 8 differentials uses all 8.
func TestComputeHandicapPair_EightRounds(t *testing.T) {
	diffs := []float64{10, 11, 12, 13, 14, 15, 16, 17}
	hi, ah := services.ComputeHandicapPair(diffs)
	require.NotNil(t, hi)
	require.NotNil(t, ah)
	// avg of all 8 = 108/8 = 13.5; hi = 13.5×0.96 = 12.96 → 13.0
	assert.Equal(t, 13.0, *hi)
	// ah = same avg 13.5 → 13.5
	assert.Equal(t, 13.5, *ah)
}

// TestComputeHandicapPair_TwentyRounds verifies that with 20 differentials only
// the best (lowest) 8 are used for hi and worst (highest) 8 for ah.
func TestComputeHandicapPair_TwentyRounds(t *testing.T) {
	diffs := make([]float64, 20)
	for i := range diffs {
		diffs[i] = float64(i + 1)
	}
	hi, ah := services.ComputeHandicapPair(diffs)
	require.NotNil(t, hi)
	require.NotNil(t, ah)
	// best 8: avg(1+…+8)/8 = 36/8 = 4.5; hi = 4.5×0.96 = 4.32 → 4.3
	assert.Equal(t, 4.3, *hi)
	// worst 8: avg(13+…+20)/8 = 132/8 = 16.5; ah = 16.5
	assert.Equal(t, 16.5, *ah)
}

// ─── Tier 2 — DB-backed tests ─────────────────────────────────────────────────

// TestUserService_GetMe_Found verifies that a seeded user is returned correctly.
func TestUserService_GetMe_Found(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)

	user := seedUser(t, db, "getme")

	data, err := svc.GetMe(context.Background(), user.ID)
	require.NoError(t, err)
	require.NotNil(t, data)
	assert.Equal(t, user.ID.String(), data.ID)
	assert.Equal(t, user.DisplayName, data.DisplayName)
	assert.Equal(t, user.Email, data.Email)
}

// TestUserService_GetMe_NotFound verifies that a missing user returns ErrUserNotFound.
func TestUserService_GetMe_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)

	_, err := svc.GetMe(context.Background(), uuid.New())
	assert.True(t, errors.Is(err, services.ErrUserNotFound))
}

// TestUserService_GetUserProfile_Found verifies profile counts and is_following flag.
func TestUserService_GetUserProfile_Found(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)

	caller := seedUser(t, db, "prof_caller")
	target := seedUser(t, db, "prof_target")

	data, err := svc.GetUserProfile(context.Background(), caller.ID, target.ID)
	require.NoError(t, err)
	require.NotNil(t, data)
	assert.Equal(t, target.ID.String(), data.ID)
	assert.False(t, data.IsFollowing)
	assert.False(t, data.IsMe)
}

// TestUserService_GetUserProfile_NotFound verifies ErrUserNotFound for a missing user.
func TestUserService_GetUserProfile_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)

	caller := seedUser(t, db, "prof_caller2")
	_, err := svc.GetUserProfile(context.Background(), caller.ID, uuid.New())
	assert.True(t, errors.Is(err, services.ErrUserNotFound))
}

// TestUserService_FollowUser_Success verifies that a follow is created and is_following
// is reflected in subsequent GetUserProfile.
func TestUserService_FollowUser_Success(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)

	caller := seedUser(t, db, "flw_caller")
	target := seedUser(t, db, "flw_target")

	require.NoError(t, svc.FollowUser(context.Background(), caller.ID, target.ID))

	data, err := svc.GetUserProfile(context.Background(), caller.ID, target.ID)
	require.NoError(t, err)
	assert.True(t, data.IsFollowing)
}

// TestUserService_FollowUser_Self verifies that following yourself returns ErrFollowSelf.
func TestUserService_FollowUser_Self(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)

	user := seedUser(t, db, "self_flw")
	err := svc.FollowUser(context.Background(), user.ID, user.ID)
	assert.True(t, errors.Is(err, services.ErrFollowSelf))
}

// TestUserService_FollowUser_AlreadyFollowing verifies that a duplicate follow
// returns ErrAlreadyFollowing.
func TestUserService_FollowUser_AlreadyFollowing(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)

	caller := seedUser(t, db, "dup_caller")
	target := seedUser(t, db, "dup_target")

	require.NoError(t, svc.FollowUser(context.Background(), caller.ID, target.ID))
	err := svc.FollowUser(context.Background(), caller.ID, target.ID)
	assert.True(t, errors.Is(err, services.ErrAlreadyFollowing))
}

// TestUserService_UnfollowUser_Idempotent verifies that unfollowing a user you
// don't follow returns no error.
func TestUserService_UnfollowUser_Idempotent(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)

	caller := seedUser(t, db, "unflw_caller")
	target := seedUser(t, db, "unflw_target")

	require.NoError(t, svc.UnfollowUser(context.Background(), caller.ID, target.ID))
}

// TestUserService_GetUserStats_EmptyReturnsZero verifies that a user with no
// completed rounds returns an empty stats response with the correct filter label.
func TestUserService_GetUserStats_EmptyReturnsZero(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)

	user := seedUser(t, db, "stats_empty")

	data, err := svc.GetUserStats(context.Background(), user.ID, "all_time")
	require.NoError(t, err)
	require.NotNil(t, data)
	assert.Equal(t, "all_time", data.Filter)
	assert.Equal(t, 0, data.RoundsCounted)
	assert.Nil(t, data.AvgGrossPerRound)
}

// TestUserService_GetScorecardSettings_NoRowReturnsDefaults verifies that a user
// with no settings row gets the canonical defaults without creating a DB row.
func TestUserService_GetScorecardSettings_NoRowReturnsDefaults(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)

	user := seedUser(t, db, "sc_defaults")

	data, err := svc.GetScorecardSettings(context.Background(), user.ID)
	require.NoError(t, err)
	require.NotNil(t, data)
	assert.True(t, data.FIREnabled)
	assert.True(t, data.GIREnabled)
	assert.False(t, data.TeeShotClubEnabled)
	assert.Equal(t, "last", data.ScorePosition)
	assert.NotEmpty(t, data.StatOrder)
}

// TestUserService_UpsertScorecardSettings_SavesAndReturns verifies that settings
// are persisted and returned correctly, and that a second Get reflects the saved values.
func TestUserService_UpsertScorecardSettings_SavesAndReturns(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)

	user := seedUser(t, db, "sc_save")

	in := services.ScorecardSettingsInput{
		FIREnabled:               false,
		GIREnabled:               true,
		PuttsEnabled:             true,
		FirstPuttDistanceEnabled: false,
		PuttDistanceMadeEnabled:  false,
		ApproachYdsEnabled:       true,
		TeeShotClubEnabled:       true,
		TeeShotDistanceEnabled:   false,
		StatOrder:                []string{"gir", "putts", "fir"},
		ScorePosition:            "first",
	}

	data, err := svc.UpsertScorecardSettings(context.Background(), user.ID, in)
	require.NoError(t, err)
	require.NotNil(t, data)
	assert.False(t, data.FIREnabled)
	assert.True(t, data.TeeShotClubEnabled)
	assert.Equal(t, "first", data.ScorePosition)
	assert.Equal(t, []string{"gir", "putts", "fir"}, data.StatOrder)

	// Re-fetch via Get to confirm the row was persisted.
	fetched, err := svc.GetScorecardSettings(context.Background(), user.ID)
	require.NoError(t, err)
	assert.Equal(t, "first", fetched.ScorePosition)
	assert.Equal(t, []string{"gir", "putts", "fir"}, fetched.StatOrder)
}
