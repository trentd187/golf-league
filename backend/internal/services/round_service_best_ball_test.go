// services/round_service_best_ball_test.go
// Integration tests for the Best Ball additions to RoundService: the per-round
// gross/net basis toggle and the format-aware team-size cap (Best Ball allows
// free-form team sizes; the max-2 cap is Las Vegas–only). Tier 2 — uses
// testutil.NewTestDB (Docker required). Shares the fixtures (seedUser, seedEvent,
// addEventMember, seedCourseWithTee, strPtr) defined in round_service_test.go and
// round_service_vegas_test.go (same package).
package services_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/services"
	"github.com/trentd187/golf-league/internal/testutil"
)

// scheduleBestBallRound schedules a best_ball round with the given basis pointer
// (nil = service default "gross") and returns the created round result.
func scheduleBestBallRound(t *testing.T, svc *services.RoundService, eventID, callerID uuid.UUID, courseID, teeID string, basis *string) services.ScheduleRoundResult {
	t.Helper()
	fmt := "best_ball"
	result, err := svc.Schedule(context.Background(), eventID, callerID, "user", services.ScheduleRoundInput{
		ScheduledDate:        time.Now().UTC().Format("2006-01-02"),
		CourseID:             &courseID,
		DefaultTeeID:         &teeID,
		ScoringFormat:        &fmt,
		BestBallScoringBasis: basis,
	})
	require.NoError(t, err)
	return result
}

// ─── Best Ball basis toggle ──────────────────────────────────────────────────────

func TestRoundService_Schedule_BestBallBasisDefault(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "bbOrg1")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Best Ball National 1")

	// No basis pointer → default "gross".
	result := scheduleBestBallRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String(), nil)

	var round models.Round
	require.NoError(t, db.First(&round, "id = ?", result.Round.ID).Error)
	assert.Equal(t, "gross", round.BestBallScoringBasis)
}

func TestRoundService_Schedule_BestBallBasisPersisted(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "bbOrg2")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Best Ball National 2")

	basis := "net"
	result := scheduleBestBallRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String(), &basis)

	var round models.Round
	require.NoError(t, db.First(&round, "id = ?", result.Round.ID).Error)
	assert.Equal(t, "net", round.BestBallScoringBasis)
}

func TestRoundService_Schedule_InvalidBestBallBasisRejected(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "bbOrg3")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Best Ball National 3")

	fmt := "best_ball"
	bad := "stableford"
	_, err := svc.Schedule(context.Background(), event.ID, organizer.ID, "user", services.ScheduleRoundInput{
		ScheduledDate:        time.Now().UTC().Format("2006-01-02"),
		CourseID:             strPtr(course.ID.String()),
		DefaultTeeID:         strPtr(tee.ID.String()),
		ScoringFormat:        &fmt,
		BestBallScoringBasis: &bad,
	})
	var ve *services.ValidationError
	require.ErrorAs(t, err, &ve)
	assert.Equal(t, "best_ball_scoring_basis", ve.Field)
}

func TestRoundService_Update_BestBallBasis(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "bbOrg4")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Best Ball National 4")
	result := scheduleBestBallRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String(), nil)

	basis := "net"
	_, err := svc.Update(context.Background(), result.Round.ID, organizer.ID, "user", services.UpdateRoundInput{
		BestBallScoringBasis: &basis,
	})
	require.NoError(t, err)

	var round models.Round
	require.NoError(t, db.First(&round, "id = ?", result.Round.ID).Error)
	assert.Equal(t, "net", round.BestBallScoringBasis)
}

func TestRoundService_CreateEventlessRound_BestBallBasis(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))

	creator := seedUser(t, db, "bbSolo1")
	course, tee := seedCourseWithTee(t, db, "Best Ball National Solo")

	fmt := "best_ball"
	basis := "net"
	result, err := svc.CreateEventlessRound(context.Background(), creator.ID, services.CreateEventlessRoundInput{
		ScheduledDate:        time.Now().UTC().Format("2006-01-02"),
		CourseID:             strPtr(course.ID.String()),
		DefaultTeeID:         strPtr(tee.ID.String()),
		ScoringFormat:        &fmt,
		BestBallScoringBasis: &basis,
	})
	require.NoError(t, err)

	var round models.Round
	require.NoError(t, db.First(&round, "id = ?", result.Round.ID).Error)
	assert.Equal(t, "net", round.BestBallScoringBasis)
}

// ─── Format-aware team-size cap ───────────────────────────────────────────────────

// bestBallRoundWithGroup schedules a best_ball round and returns the round, its
// first group ID, the event, and the organizer.
func bestBallRoundWithGroup(t *testing.T, svc *services.RoundService, eventSvc *services.EventService, db *gorm.DB, namePrefix string) (uuid.UUID, uuid.UUID, models.Event, models.User) {
	t.Helper()
	organizer := seedUser(t, db, namePrefix+"Org")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, namePrefix+" Course")
	result := scheduleBestBallRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String(), nil)
	var group models.Group
	require.NoError(t, db.Where("round_id = ?", result.Round.ID).First(&group).Error)
	return result.Round.ID, group.ID, event, organizer
}

// Best Ball permits free-form team sizes: a team of 4 (which Vegas would reject
// with ErrTeamFull) must be accepted.
func TestRoundService_AssignTeamMembers_BestBallAllowsLargeTeams(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	roundID, groupID, event, organizer := bestBallRoundWithGroup(t, svc, eventSvc, db, "bbat1")
	_, rp1 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "bbat1p1")
	_, rp2 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "bbat1p2")
	_, rp3 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "bbat1p3")
	_, rp4 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "bbat1p4")

	team, err := svc.CreateTeam(context.Background(), roundID, organizer.ID, "user", "Team A")
	require.NoError(t, err)

	result, err := svc.AssignTeamMembers(context.Background(), roundID, team.Team.ID, organizer.ID, "user", []uuid.UUID{rp1, rp2, rp3, rp4})
	require.NoError(t, err)
	assert.Len(t, result.Members, 4, "best_ball should allow teams larger than two")
}
