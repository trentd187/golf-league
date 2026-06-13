// services/round_service_vegas_test.go
// Integration tests for the Las Vegas additions to RoundService: per-round vegas
// toggles (birdie flip + scoring basis) and the teams CRUD used for partner
// assignment. Tier 2 — uses testutil.NewTestDB (Docker required). Shares the
// fixtures (seedUser, seedEvent, addEventMember, seedCourseWithTee) defined in
// round_service_test.go (same package).
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

// scheduleVegasRound schedules a las_vegas round with the given toggle pointers
// (nil = service default) and returns the created round.
func scheduleVegasRound(t *testing.T, svc *services.RoundService, eventID, callerID uuid.UUID, courseID, teeID string, flip *bool, basis *string) services.ScheduleRoundResult {
	t.Helper()
	fmt := "las_vegas"
	result, err := svc.Schedule(context.Background(), eventID, callerID, "user", services.ScheduleRoundInput{
		ScheduledDate:     time.Now().UTC().Format("2006-01-02"),
		CourseID:          &courseID,
		DefaultTeeID:      &teeID,
		ScoringFormat:     &fmt,
		VegasBirdieFlip:   flip,
		VegasScoringBasis: basis,
	})
	require.NoError(t, err)
	return result
}

// addVegasPlayer seeds a user, registers them in the event, adds them to the
// group, and returns their round_player_id.
func addVegasPlayer(t *testing.T, svc *services.RoundService, db *gorm.DB, roundID, groupID, eventID, organizerID uuid.UUID, name string) (models.User, uuid.UUID) {
	t.Helper()
	u := seedUser(t, db, name)
	addEventMember(t, db, eventID, u.ID)
	res, err := svc.AddGroupMember(context.Background(), roundID, groupID, organizerID, u.ID, "user")
	require.NoError(t, err)
	var rpID uuid.UUID
	for _, p := range res.Players {
		if p.UserID == u.ID.String() {
			rpID = uuid.MustParse(p.RoundPlayerID)
		}
	}
	require.NotEqual(t, uuid.Nil, rpID, "round_player_id should be resolved for %s", name)
	return u, rpID
}

// ─── Vegas toggles ──────────────────────────────────────────────────────────────

func TestRoundService_Schedule_VegasTogglesDefault(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "vegasOrg1")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Vegas National 1")

	// No toggle pointers → defaults: flip true, basis "gross".
	result := scheduleVegasRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String(), nil, nil)

	var round models.Round
	require.NoError(t, db.First(&round, "id = ?", result.Round.ID).Error)
	assert.True(t, round.VegasBirdieFlip)
	assert.Equal(t, "gross", round.VegasScoringBasis)
}

func TestRoundService_Schedule_VegasTogglesPersisted(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "vegasOrg2")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Vegas National 2")

	flip := false
	basis := "net"
	result := scheduleVegasRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String(), &flip, &basis)

	var round models.Round
	require.NoError(t, db.First(&round, "id = ?", result.Round.ID).Error)
	assert.False(t, round.VegasBirdieFlip)
	assert.Equal(t, "net", round.VegasScoringBasis)
}

func TestRoundService_Schedule_InvalidVegasBasisRejected(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "vegasOrg3")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Vegas National 3")

	fmt := "las_vegas"
	bad := "stableford"
	_, err := svc.Schedule(context.Background(), event.ID, organizer.ID, "user", services.ScheduleRoundInput{
		ScheduledDate:     time.Now().UTC().Format("2006-01-02"),
		CourseID:          strPtr(course.ID.String()),
		DefaultTeeID:      strPtr(tee.ID.String()),
		ScoringFormat:     &fmt,
		VegasScoringBasis: &bad,
	})
	var ve *services.ValidationError
	require.ErrorAs(t, err, &ve)
	assert.Equal(t, "vegas_scoring_basis", ve.Field)
}

func TestRoundService_Update_VegasToggles(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "vegasOrg4")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Vegas National 4")
	result := scheduleVegasRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String(), nil, nil)

	flip := false
	basis := "net"
	_, err := svc.Update(context.Background(), result.Round.ID, organizer.ID, "user", services.UpdateRoundInput{
		VegasBirdieFlip:   &flip,
		VegasScoringBasis: &basis,
	})
	require.NoError(t, err)

	var round models.Round
	require.NoError(t, db.First(&round, "id = ?", result.Round.ID).Error)
	assert.False(t, round.VegasBirdieFlip)
	assert.Equal(t, "net", round.VegasScoringBasis)
}

func TestRoundService_CreateEventlessRound_VegasToggles(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))

	creator := seedUser(t, db, "vegasSolo1")
	course, tee := seedCourseWithTee(t, db, "Vegas National Solo")

	fmt := "las_vegas"
	flip := false
	basis := "net"
	result, err := svc.CreateEventlessRound(context.Background(), creator.ID, services.CreateEventlessRoundInput{
		ScheduledDate:     time.Now().UTC().Format("2006-01-02"),
		CourseID:          strPtr(course.ID.String()),
		DefaultTeeID:      strPtr(tee.ID.String()),
		ScoringFormat:     &fmt,
		VegasBirdieFlip:   &flip,
		VegasScoringBasis: &basis,
	})
	require.NoError(t, err)

	var round models.Round
	require.NoError(t, db.First(&round, "id = ?", result.Round.ID).Error)
	assert.False(t, round.VegasBirdieFlip)
	assert.Equal(t, "net", round.VegasScoringBasis)
}

// ─── Teams CRUD ─────────────────────────────────────────────────────────────────

// vegasRoundWithGroup schedules a vegas round and returns the round, its first
// group ID, and the event (so callers can add players).
func vegasRoundWithGroup(t *testing.T, svc *services.RoundService, eventSvc *services.EventService, db *gorm.DB, namePrefix string) (uuid.UUID, uuid.UUID, models.Event, models.User) {
	t.Helper()
	organizer := seedUser(t, db, namePrefix+"Org")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, namePrefix+" Course")
	result := scheduleVegasRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String(), nil, nil)
	var group models.Group
	require.NoError(t, db.Where("round_id = ?", result.Round.ID).First(&group).Error)
	return result.Round.ID, group.ID, event, organizer
}

func TestRoundService_CreateTeam_HappyPath(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	roundID, _, _, organizer := vegasRoundWithGroup(t, svc, eventSvc, db, "ct1")

	team, err := svc.CreateTeam(context.Background(), roundID, organizer.ID, "user", "Team A")
	require.NoError(t, err)
	assert.Equal(t, "Team A", team.Team.Name)
	assert.Empty(t, team.Members)
}

func TestRoundService_CreateTeam_NonOrganizerForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	roundID, _, _, _ := vegasRoundWithGroup(t, svc, eventSvc, db, "ct2")

	stranger := seedUser(t, db, "ct2Stranger")
	_, err := svc.CreateTeam(context.Background(), roundID, stranger.ID, "user", "Team A")
	assert.ErrorIs(t, err, services.ErrRoundForbidden)
}

func TestRoundService_AssignTeamMembers_HappyPath(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	roundID, groupID, event, organizer := vegasRoundWithGroup(t, svc, eventSvc, db, "at1")
	_, rp1 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "at1p1")
	_, rp2 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "at1p2")

	team, err := svc.CreateTeam(context.Background(), roundID, organizer.ID, "user", "Team A")
	require.NoError(t, err)

	result, err := svc.AssignTeamMembers(context.Background(), roundID, team.Team.ID, organizer.ID, "user", []uuid.UUID{rp1, rp2})
	require.NoError(t, err)
	assert.Len(t, result.Members, 2)
}

func TestRoundService_AssignTeamMembers_CapAtTwo(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	roundID, groupID, event, organizer := vegasRoundWithGroup(t, svc, eventSvc, db, "at2")
	_, rp1 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "at2p1")
	_, rp2 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "at2p2")
	_, rp3 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "at2p3")

	team, err := svc.CreateTeam(context.Background(), roundID, organizer.ID, "user", "Team A")
	require.NoError(t, err)

	_, err = svc.AssignTeamMembers(context.Background(), roundID, team.Team.ID, organizer.ID, "user", []uuid.UUID{rp1, rp2, rp3})
	assert.ErrorIs(t, err, services.ErrTeamFull)
}

func TestRoundService_AssignTeamMembers_SingleTeamPerRound(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	roundID, groupID, event, organizer := vegasRoundWithGroup(t, svc, eventSvc, db, "at3")
	_, rp1 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "at3p1")

	teamA, err := svc.CreateTeam(context.Background(), roundID, organizer.ID, "user", "Team A")
	require.NoError(t, err)
	teamB, err := svc.CreateTeam(context.Background(), roundID, organizer.ID, "user", "Team B")
	require.NoError(t, err)

	// Assign player to Team A, then to Team B — should be removed from A.
	_, err = svc.AssignTeamMembers(context.Background(), roundID, teamA.Team.ID, organizer.ID, "user", []uuid.UUID{rp1})
	require.NoError(t, err)
	_, err = svc.AssignTeamMembers(context.Background(), roundID, teamB.Team.ID, organizer.ID, "user", []uuid.UUID{rp1})
	require.NoError(t, err)

	var aCount int64
	db.Model(&models.TeamMember{}).Where("team_id = ?", teamA.Team.ID).Count(&aCount)
	assert.Equal(t, int64(0), aCount, "player should no longer be on Team A")
	var bCount int64
	db.Model(&models.TeamMember{}).Where("team_id = ?", teamB.Team.ID).Count(&bCount)
	assert.Equal(t, int64(1), bCount, "player should be on Team B")
}

func TestRoundService_AssignTeamMembers_PlayerNotInRound(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	roundID, _, _, organizer := vegasRoundWithGroup(t, svc, eventSvc, db, "at4")
	team, err := svc.CreateTeam(context.Background(), roundID, organizer.ID, "user", "Team A")
	require.NoError(t, err)

	// A random round_player_id that does not belong to this round.
	_, err = svc.AssignTeamMembers(context.Background(), roundID, team.Team.ID, organizer.ID, "user", []uuid.UUID{uuid.New()})
	assert.ErrorIs(t, err, services.ErrPlayerNotInRound)
}

func TestRoundService_AssignTeamMembers_TeamNotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	roundID, _, _, organizer := vegasRoundWithGroup(t, svc, eventSvc, db, "at5")
	_, err := svc.AssignTeamMembers(context.Background(), roundID, uuid.New(), organizer.ID, "user", []uuid.UUID{})
	assert.ErrorIs(t, err, services.ErrTeamNotFound)
}

func TestRoundService_DeleteTeam_CascadesMembers(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	roundID, groupID, event, organizer := vegasRoundWithGroup(t, svc, eventSvc, db, "dt1")
	_, rp1 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "dt1p1")

	team, err := svc.CreateTeam(context.Background(), roundID, organizer.ID, "user", "Team A")
	require.NoError(t, err)
	_, err = svc.AssignTeamMembers(context.Background(), roundID, team.Team.ID, organizer.ID, "user", []uuid.UUID{rp1})
	require.NoError(t, err)

	require.NoError(t, svc.DeleteTeam(context.Background(), roundID, team.Team.ID, organizer.ID, "user"))

	var teamCount, memberCount int64
	db.Model(&models.Team{}).Where("id = ?", team.Team.ID).Count(&teamCount)
	db.Model(&models.TeamMember{}).Where("team_id = ?", team.Team.ID).Count(&memberCount)
	assert.Equal(t, int64(0), teamCount)
	assert.Equal(t, int64(0), memberCount, "team_members should cascade-delete with the team")
}

func TestRoundService_DeleteTeam_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	roundID, _, _, organizer := vegasRoundWithGroup(t, svc, eventSvc, db, "dt2")
	err := svc.DeleteTeam(context.Background(), roundID, uuid.New(), organizer.ID, "user")
	assert.ErrorIs(t, err, services.ErrTeamNotFound)
}

func TestRoundService_ListTeams_ReturnsTeamsWithMembers(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	roundID, groupID, event, organizer := vegasRoundWithGroup(t, svc, eventSvc, db, "lt1")
	_, rp1 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "lt1p1")
	_, rp2 := addVegasPlayer(t, svc, db, roundID, groupID, event.ID, organizer.ID, "lt1p2")

	teamA, err := svc.CreateTeam(context.Background(), roundID, organizer.ID, "user", "Team A")
	require.NoError(t, err)
	_, err = svc.AssignTeamMembers(context.Background(), roundID, teamA.Team.ID, organizer.ID, "user", []uuid.UUID{rp1, rp2})
	require.NoError(t, err)
	_, err = svc.CreateTeam(context.Background(), roundID, organizer.ID, "user", "Team B")
	require.NoError(t, err)

	teams, err := svc.ListTeams(context.Background(), roundID, organizer.ID, "user")
	require.NoError(t, err)
	require.Len(t, teams, 2)
	// Teams are ordered by created_at — Team A (with 2 members) first.
	assert.Equal(t, "Team A", teams[0].Team.Name)
	assert.Len(t, teams[0].Members, 2)
	assert.Equal(t, "Team B", teams[1].Team.Name)
	assert.Empty(t, teams[1].Members)
}
