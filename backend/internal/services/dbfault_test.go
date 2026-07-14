// services/dbfault_test.go
// Tier 2 tests for one rule: A DATABASE FAULT MUST SURFACE AS A 500.
//
// The audit found the services quietly laundering real DB errors into successful-looking
// responses — an empty stats screen, a 403 "not authorized", a 409 "already following", a
// bypassed group cap. Every one of those is a 2xx or a 4xx, and ErrorLogger only escalates
// 5xx to a Sentry Issue, so the failures that mattered most were the ones we could not see.
// GORM is the trap: Count/Find/Scan return *gorm.DB, not error, so `errcheck` never flagged
// any of it.
//
// These tests inject a real, deterministic DB failure at a chosen point and assert the
// service reports it instead of shrugging.
//
// Two injection techniques, each chosen for what it can prove:
//
//   - A CANCELLED CONTEXT fails the very next query. Perfect when the unchecked query is the
//     FIRST one a method runs (see user_service_test.go).
//   - RENAMING A TABLE fails only the queries that touch it, letting the earlier ones
//     succeed. Necessary when the unchecked query sits mid-method behind correctly-checked
//     ones — a cancelled context would trip those first and prove nothing.
//
// Do NOT call t.Parallel(): the Postgres container is shared, and breakTable mutates its
// schema.
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

// breakTable renames a table out from under the code so any query touching it fails with a
// genuine driver error, and restores it when the test ends. The restore is unconditional —
// the container is shared with every other test in the process.
func breakTable(t *testing.T, db *gorm.DB, table string) {
	t.Helper()
	broken := table + "_broken"
	require.NoError(t, db.Exec(`ALTER TABLE `+table+` RENAME TO `+broken).Error)
	t.Cleanup(func() {
		_ = db.Exec(`ALTER TABLE ` + broken + ` RENAME TO ` + table).Error
	})
}

// completedRoundFixture is a user with one completed round, one score, and one hole stat —
// enough for GetUserStats to walk its whole query chain.
type completedRoundFixture struct {
	user          models.User
	roundPlayerID uuid.UUID
}

func seedCompletedRoundWithStats(t *testing.T, db *gorm.DB, suffix string) completedRoundFixture {
	t.Helper()
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, suffix+"_org")
	player := seedUser(t, db, suffix+"_plr")
	course, tee := seedCourseWithTee(t, db, "Stats Fault Course "+suffix)
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)

	ep := addEventMember(t, db, event.ID, player.ID)
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())
	rp := addRoundPlayer(t, db, result.Round.ID, ep.ID)

	require.NoError(t, db.Model(&models.Round{}).Where("id = ?", result.Round.ID).
		Update("status", models.RoundStatusCompleted).Error)
	require.NoError(t, db.Create(&models.Score{
		RoundPlayerID: rp.ID, HoleNumber: 1, GrossScore: 5, NetScore: 5, EnteredBy: player.ID,
	}).Error)
	putts := 2
	require.NoError(t, db.Create(&models.HoleStat{
		RoundPlayerID: rp.ID, HoleNumber: 1, Putts: &putts,
	}).Error)

	return completedRoundFixture{user: player, roundPlayerID: rp.ID}
}

// ─── UserService: an outage must not read as "this user has no data" ──────────

// GetUserProfile's own user lookup was checked, but the three Counts behind it were not — so
// a broken round_players table returned a profile showing 0 rounds played, with a 200.
func TestUserService_GetUserProfile_DBFailure_ReturnsErrorNotZeroCounts(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewUserService(db)
	caller := seedUser(t, db, "profile_fault_a")
	target := seedUser(t, db, "profile_fault_b")

	breakTable(t, db, "round_players")

	data, err := svc.GetUserProfile(context.Background(), caller.ID, target.ID)

	require.Error(t, err, "a broken round_players must not be reported as 'played 0 rounds'")
	assert.Nil(t, data)
}

// The three mid-method scans in GetUserStats. A cancelled context can't reach them (the
// round-player scan runs first and would fail), so each table is broken in turn.
func TestUserService_GetUserStats_DBFailure_MidQuery_ReturnsError(t *testing.T) {
	// Each entry breaks one table the stats chain depends on, AFTER the round-player scan
	// has already succeeded.
	cases := []struct {
		name  string
		table string
	}{
		{"par lookup fails", "holes"},
		{"score scan fails", "scores"},
		{"hole-stat scan fails", "hole_stats"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := testutil.NewTestDB(t)
			svc := services.NewUserService(db)
			fx := seedCompletedRoundWithStats(t, db, "sf")

			breakTable(t, db, tc.table)

			data, err := svc.GetUserStats(context.Background(), fx.user.ID, "all_time")

			require.Error(t, err, "a mid-chain DB fault must not return partial stats with a 200")
			assert.Nil(t, data)
		})
	}
}

// ─── RoundService: an outage must not bypass a constraint ─────────────────────

// The player-count Count is the ONLY thing enforcing the 4-player group cap. Unchecked, a DB
// error left currentCount at 0, the `>= 4` test passed, and a fifth player joined the group
// with no error anywhere.
func TestRoundService_AddGroupMember_DBFailure_DoesNotSilentlyBypassTheGroupCap(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "cap_org")
	joiner := seedUser(t, db, "cap_joiner")
	course, tee := seedCourseWithTee(t, db, "Cap Fault Course")
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)
	addEventMember(t, db, event.ID, joiner.ID)
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	group, err := roundSvc.CreateGroup(context.Background(), result.Round.ID, organizer.ID, "user")
	require.NoError(t, err)

	breakTable(t, db, "group_players")

	_, err = roundSvc.AddGroupMember(context.Background(), result.Round.ID, group.Group.ID,
		organizer.ID, joiner.ID, "user")

	require.Error(t, err, "a failed player Count must abort, not fall through with count=0")
}

// CreateGroup's MAX(group_number) scan was unchecked: on a DB error maxGroupNum stayed 0 and
// the new group collided on "Group 1".
func TestRoundService_CreateGroup_DBFailure_DoesNotCollideOnGroupNumber(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "grp_org")
	course, tee := seedCourseWithTee(t, db, "Group Fault Course")
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	breakTable(t, db, "groups")

	_, err := roundSvc.CreateGroup(context.Background(), result.Round.ID, organizer.ID, "user")

	require.Error(t, err, "a failed MAX(group_number) scan must abort, not number every group 1")
}
