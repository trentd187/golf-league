// services/round_service_teams_test.go
// Tier 2 tests for ReplaceGroupTeams — the atomic team bulk-replace.
//
// Why this endpoint exists, and what these tests pin: the mobile assignment modals used to
// replace a group's teams with N separate requests (DELETE every existing team, then POST each
// new team and PUT its members). Every individual call was hardened with retry + idempotency,
// but the SEQUENCE was not atomic. When a create failed after the deletes had already landed —
// a cellular drop past the retry budget, a 5xx — the group was left with NO TEAMS AT ALL and
// the previous partnerships were gone. Real data loss, mid-round, on exactly the flaky network
// this app is built for.
//
// The headline test is TestRoundService_ReplaceGroupTeams_FailureLeavesOldTeamsIntact.
//
// Shares fixtures with round_service_test.go / round_service_vegas_test.go (same package).
// Do NOT call t.Parallel().
package services_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/services"
	"github.com/trentd187/golf-league/internal/testutil"
)

// vegasGroupFixture is a las_vegas round with one group of four players.
type vegasGroupFixture struct {
	roundID   uuid.UUID
	groupID   uuid.UUID
	organizer models.User
	rpIDs     []uuid.UUID
	svc       *services.RoundService
}

func seedVegasGroupOfFour(t *testing.T, db *gorm.DB, suffix string) vegasGroupFixture {
	t.Helper()
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, suffix+"_org")
	course, tee := seedCourseWithTee(t, db, "Teams Course "+suffix)
	event := seedEvent(t, eventSvc, organizer.ID)
	result := scheduleVegasRound(t, roundSvc, event.ID, organizer.ID,
		course.ID.String(), tee.ID.String(), nil, nil)

	grp, err := roundSvc.CreateGroup(context.Background(), result.Round.ID, organizer.ID, "user")
	require.NoError(t, err)

	rpIDs := make([]uuid.UUID, 0, 4)
	for _, name := range []string{"a", "b", "c", "d"} {
		_, rpID := addVegasPlayer(t, roundSvc, db, result.Round.ID, grp.Group.ID,
			event.ID, organizer.ID, suffix+"_"+name)
		rpIDs = append(rpIDs, rpID)
	}

	return vegasGroupFixture{
		roundID:   result.Round.ID,
		groupID:   grp.Group.ID,
		organizer: organizer,
		rpIDs:     rpIDs,
		svc:       roundSvc,
	}
}

// teamCount returns how many teams currently exist on the round.
func teamCount(t *testing.T, db *gorm.DB, roundID uuid.UUID) int64 {
	t.Helper()
	var n int64
	require.NoError(t, db.Model(&models.Team{}).Where("round_id = ?", roundID).Count(&n).Error)
	return n
}

func TestRoundService_ReplaceGroupTeams_CreatesBothSides(t *testing.T) {
	db := testutil.NewTestDB(t)
	fx := seedVegasGroupOfFour(t, db, "rgt_create")

	out, err := fx.svc.ReplaceGroupTeams(context.Background(), fx.roundID, fx.groupID,
		fx.organizer.ID, "user", []services.TeamSpec{
			{Name: "A & B", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[0], fx.rpIDs[1]}},
			{Name: "C & D", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[2], fx.rpIDs[3]}},
		})

	require.NoError(t, err)
	require.Len(t, out, 2)
	assert.Len(t, out[0].Members, 2)
	assert.Len(t, out[1].Members, 2)
	assert.Equal(t, int64(2), teamCount(t, db, fx.roundID))
}

// A second call must REPLACE, not accumulate — the whole point of a set-replace endpoint.
func TestRoundService_ReplaceGroupTeams_ReplacesRatherThanAccumulates(t *testing.T) {
	db := testutil.NewTestDB(t)
	fx := seedVegasGroupOfFour(t, db, "rgt_replace")
	ctx := context.Background()

	_, err := fx.svc.ReplaceGroupTeams(ctx, fx.roundID, fx.groupID, fx.organizer.ID, "user",
		[]services.TeamSpec{
			{Name: "A & B", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[0], fx.rpIDs[1]}},
			{Name: "C & D", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[2], fx.rpIDs[3]}},
		})
	require.NoError(t, err)

	// Re-partition the same four players into different pairs.
	out, err := fx.svc.ReplaceGroupTeams(ctx, fx.roundID, fx.groupID, fx.organizer.ID, "user",
		[]services.TeamSpec{
			{Name: "A & C", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[0], fx.rpIDs[2]}},
			{Name: "B & D", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[1], fx.rpIDs[3]}},
		})

	require.NoError(t, err)
	require.Len(t, out, 2)
	assert.Equal(t, int64(2), teamCount(t, db, fx.roundID), "the old teams must be gone, not kept")
	assert.Equal(t, "A & C", out[0].Team.Name)
}

// ─── The headline: a failed save must not destroy the existing teams ──────────
//
// This is the data-loss bug. Under the old client-side delete-then-recreate loop, a failure
// during creation left the group with zero teams. With the replace running inside one
// transaction, a failure mid-way must roll the deletes back too.
//
// The failure is injected by breaking team_members, which the create step writes to but the
// delete step's Pluck reads first — so the deletes are attempted and the create then fails.
func TestRoundService_ReplaceGroupTeams_FailureLeavesOldTeamsIntact(t *testing.T) {
	db := testutil.NewTestDB(t)
	fx := seedVegasGroupOfFour(t, db, "rgt_atomic")
	ctx := context.Background()

	_, err := fx.svc.ReplaceGroupTeams(ctx, fx.roundID, fx.groupID, fx.organizer.ID, "user",
		[]services.TeamSpec{
			{Name: "A & B", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[0], fx.rpIDs[1]}},
			{Name: "C & D", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[2], fx.rpIDs[3]}},
		})
	require.NoError(t, err)
	require.Equal(t, int64(2), teamCount(t, db, fx.roundID))

	// Fail ONLY the member INSERT. A trigger is the surgical tool here: breaking the whole
	// table would also break the delete step's SELECT, so the deletes would never be attempted
	// and the test would prove nothing. This way the deletes run, the create then blows up,
	// and we get to assert the deletes were rolled back.
	require.NoError(t, db.Exec(`
		CREATE FUNCTION fail_team_member_insert() RETURNS trigger AS $$
		BEGIN RAISE EXCEPTION 'injected failure'; END;
		$$ LANGUAGE plpgsql;
		CREATE TRIGGER inject_failure BEFORE INSERT ON team_members
		FOR EACH ROW EXECUTE FUNCTION fail_team_member_insert();
	`).Error)
	t.Cleanup(func() {
		_ = db.Exec(`DROP TRIGGER IF EXISTS inject_failure ON team_members`).Error
		_ = db.Exec(`DROP FUNCTION IF EXISTS fail_team_member_insert()`).Error
	})

	_, err = fx.svc.ReplaceGroupTeams(ctx, fx.roundID, fx.groupID, fx.organizer.ID, "user",
		[]services.TeamSpec{
			{Name: "A & C", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[0], fx.rpIDs[2]}},
			{Name: "B & D", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[1], fx.rpIDs[3]}},
		})

	require.Error(t, err, "the member insert must fail")
	assert.Equal(t, int64(2), teamCount(t, db, fx.roundID),
		"a failed replace must ROLL BACK the deletes — the organizer's existing teams must survive")
}

// ─── Validation ───────────────────────────────────────────────────────────────

func TestRoundService_ReplaceGroupTeams_VegasCapsTeamsAtTwo(t *testing.T) {
	db := testutil.NewTestDB(t)
	fx := seedVegasGroupOfFour(t, db, "rgt_cap")

	_, err := fx.svc.ReplaceGroupTeams(context.Background(), fx.roundID, fx.groupID,
		fx.organizer.ID, "user", []services.TeamSpec{
			{Name: "Everyone", RoundPlayerIDs: fx.rpIDs}, // 4 on one Vegas team
		})

	assert.ErrorIs(t, err, services.ErrTeamFull)
}

func TestRoundService_ReplaceGroupTeams_RejectsAPlayerOnTwoTeams(t *testing.T) {
	db := testutil.NewTestDB(t)
	fx := seedVegasGroupOfFour(t, db, "rgt_dupe")

	_, err := fx.svc.ReplaceGroupTeams(context.Background(), fx.roundID, fx.groupID,
		fx.organizer.ID, "user", []services.TeamSpec{
			{Name: "A & B", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[0], fx.rpIDs[1]}},
			{Name: "A & C", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[0], fx.rpIDs[2]}}, // A twice
		})

	require.Error(t, err)
	var ve *services.ValidationError
	assert.ErrorAs(t, err, &ve)
}

// An organizer must not be able to reach into another group by naming its players.
func TestRoundService_ReplaceGroupTeams_RejectsPlayerFromAnotherGroup(t *testing.T) {
	db := testutil.NewTestDB(t)
	fx := seedVegasGroupOfFour(t, db, "rgt_outsider")
	other := seedVegasGroupOfFour(t, db, "rgt_other")

	_, err := fx.svc.ReplaceGroupTeams(context.Background(), fx.roundID, fx.groupID,
		fx.organizer.ID, "user", []services.TeamSpec{
			{Name: "Bad", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[0], other.rpIDs[0]}},
		})

	assert.ErrorIs(t, err, services.ErrPlayerNotInRound)
}

func TestRoundService_ReplaceGroupTeams_NonOrganizerForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	fx := seedVegasGroupOfFour(t, db, "rgt_forbid")
	outsider := seedUser(t, db, "rgt_outsider_user")

	_, err := fx.svc.ReplaceGroupTeams(context.Background(), fx.roundID, fx.groupID,
		outsider.ID, "user", []services.TeamSpec{
			{Name: "A & B", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[0], fx.rpIDs[1]}},
		})

	assert.ErrorIs(t, err, services.ErrRoundForbidden)
}

// Sending no teams clears the group — the natural meaning of replacing a set with nothing.
func TestRoundService_ReplaceGroupTeams_EmptySetClearsTheGroupsTeams(t *testing.T) {
	db := testutil.NewTestDB(t)
	fx := seedVegasGroupOfFour(t, db, "rgt_clear")
	ctx := context.Background()

	_, err := fx.svc.ReplaceGroupTeams(ctx, fx.roundID, fx.groupID, fx.organizer.ID, "user",
		[]services.TeamSpec{
			{Name: "A & B", RoundPlayerIDs: []uuid.UUID{fx.rpIDs[0], fx.rpIDs[1]}},
		})
	require.NoError(t, err)
	require.Equal(t, int64(1), teamCount(t, db, fx.roundID))

	out, err := fx.svc.ReplaceGroupTeams(ctx, fx.roundID, fx.groupID, fx.organizer.ID, "user", nil)

	require.NoError(t, err)
	assert.Empty(t, out)
	assert.Equal(t, int64(0), teamCount(t, db, fx.roundID))
}
