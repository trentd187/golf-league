// services/score_service_test.go
// Integration tests for ScoreService. Uses testutil.NewTestDB to spin up an
// ephemeral Postgres container — Docker must be running.
//
// Tier 1 paths (enum validation, body/UUID parsing) are covered by handler
// tests in handlers/scores_test.go via nilScoreSvc().
// Everything here is Tier 2: real DB, real constraints, real net-score math.
//
// Do NOT call t.Parallel() — TRUNCATE is global across the shared container.
package services_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/services"
	"github.com/trentd187/golf-league/internal/testutil"
)

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// seedHoles inserts 18 holes for a tee: par 4, stroke_index = hole_number (1=hardest).
func seedHoles(t *testing.T, db *gorm.DB, teeID uuid.UUID) {
	t.Helper()
	for i := 1; i <= 18; i++ {
		y := 150 + i*5
		h := models.Hole{TeeID: teeID, HoleNumber: i, Par: 4, StrokeIndex: i, Yardage: &y}
		require.NoError(t, db.Create(&h).Error)
	}
}

// addRoundPlayer directly inserts a round_player for an event_player.
// Looks up the event_player to populate UserID (required since migration 000020).
// Omit(clause.Associations) prevents GORM from auto-creating phantom records.
func addRoundPlayer(t *testing.T, db *gorm.DB, roundID, eventPlayerID uuid.UUID) models.RoundPlayer {
	t.Helper()
	var ep models.EventPlayer
	require.NoError(t, db.First(&ep, "id = ?", eventPlayerID).Error)
	rp := models.RoundPlayer{
		RoundID: roundID, EventPlayerID: &eventPlayerID, UserID: ep.UserID,
		Status: models.RoundPlayerStatusRegistered,
	}
	require.NoError(t, db.Omit(clause.Associations).Create(&rp).Error)
	return rp
}

// addGroupWithPlayer assigns a round_player to the group with the given group_number,
// reusing it if it already exists (Schedule always creates a default group 1).
// Omit(clause.Associations) prevents GORM from auto-creating phantom records.
func addGroupWithPlayer(t *testing.T, db *gorm.DB, roundID uuid.UUID, groupNumber int, rpID uuid.UUID) models.Group {
	t.Helper()
	var group models.Group
	err := db.Where("round_id = ? AND group_number = ?", roundID, groupNumber).First(&group).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		group = models.Group{RoundID: roundID, GroupNumber: groupNumber}
		require.NoError(t, db.Omit(clause.Associations).Create(&group).Error)
	} else {
		require.NoError(t, err)
	}
	gp := models.GroupPlayer{GroupID: group.ID, RoundPlayerID: rpID}
	require.NoError(t, db.Omit(clause.Associations).Create(&gp).Error)
	return group
}

// newScoreSvc builds a ScoreService backed by the test DB.
func newScoreSvc(db *gorm.DB) *services.ScoreService {
	return services.NewScoreService(db, services.NewEventService(db))
}

// activateRound sets a round's status to "active" so non-organizer score paths are reachable.
func activateRound(t *testing.T, db *gorm.DB, roundID uuid.UUID) {
	t.Helper()
	require.NoError(t, db.Model(&models.Round{}).Where("id = ?", roundID).Update("status", "active").Error)
}

// ─── SetHandicap (exercises canModifyScores) ──────────────────────────────────

// TestScoreService_SetHandicap_OrganizerCanSet verifies that the event organizer
// can set a handicap for any player in the round.
func TestScoreService_SetHandicap_OrganizerCanSet(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	player := seedUser(t, db, "player")
	course, tee := seedCourseWithTee(t, db, "SetHCP Org Course")
	event := seedEvent(t, eventSvc, organizer.ID)

	playerEP := addEventMember(t, db, event.ID, player.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)
	rp := addRoundPlayer(t, db, result.Round.ID, playerEP.ID)

	err := svc.SetHandicap(context.Background(), result.Round.ID, rp.ID, organizer.ID, "user", 12)
	require.NoError(t, err)

	var updated models.RoundPlayer
	require.NoError(t, db.First(&updated, "id = ?", rp.ID).Error)
	require.NotNil(t, updated.CourseHandicap)
	assert.Equal(t, 12, *updated.CourseHandicap)
}

// TestScoreService_SetHandicap_SameGroupCanSet verifies that a player in the same
// tee-time group can set another player's handicap.
func TestScoreService_SetHandicap_SameGroupCanSet(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	playerA := seedUser(t, db, "pA")
	playerB := seedUser(t, db, "pB")
	course, tee := seedCourseWithTee(t, db, "SameGroup Course")
	event := seedEvent(t, eventSvc, organizer.ID)

	epA := addEventMember(t, db, event.ID, playerA.ID)
	epB := addEventMember(t, db, event.ID, playerB.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	rpA := addRoundPlayer(t, db, result.Round.ID, epA.ID)
	rpB := addRoundPlayer(t, db, result.Round.ID, epB.ID)

	// Put both players in the same group.
	group := addGroupWithPlayer(t, db, result.Round.ID, 1, rpA.ID)
	require.NoError(t, db.Omit(clause.Associations).Create(&models.GroupPlayer{GroupID: group.ID, RoundPlayerID: rpB.ID}).Error)

	activateRound(t, db, result.Round.ID)

	// playerA sets handicap for playerB — same group, allowed.
	err := svc.SetHandicap(context.Background(), result.Round.ID, rpB.ID, playerA.ID, "user", 8)
	require.NoError(t, err)
}

// TestScoreService_SetHandicap_DifferentGroupForbidden verifies that a player in a
// different group cannot set another player's handicap.
func TestScoreService_SetHandicap_DifferentGroupForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	playerA := seedUser(t, db, "pA")
	playerB := seedUser(t, db, "pB")
	course, tee := seedCourseWithTee(t, db, "DiffGroup Course")
	event := seedEvent(t, eventSvc, organizer.ID)

	epA := addEventMember(t, db, event.ID, playerA.ID)
	epB := addEventMember(t, db, event.ID, playerB.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	rpA := addRoundPlayer(t, db, result.Round.ID, epA.ID)
	rpB := addRoundPlayer(t, db, result.Round.ID, epB.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rpA.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 2, rpB.ID)

	activateRound(t, db, result.Round.ID)

	err := svc.SetHandicap(context.Background(), result.Round.ID, rpB.ID, playerA.ID, "user", 5)
	assert.True(t, errors.Is(err, services.ErrScoreForbidden))
}

// TestScoreService_SetHandicap_RecalculatesNetScores verifies that changing a
// player's course_handicap back-fills net_score on all existing score rows so
// the leaderboard reflects the updated handicap without requiring re-entry.
// Regression test for: handicap edit mid-round left stale net scores.
func TestScoreService_SetHandicap_RecalculatesNetScores(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	course, tee := seedCourseWithTee(t, db, "Recalc Course")
	seedHoles(t, db, tee.ID) // SI=hole_number (hole 1 = hardest)
	event := seedEvent(t, eventSvc, organizer.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	var organizerEP models.EventPlayer
	require.NoError(t, db.Where("event_id = ? AND user_id = ?", event.ID, organizer.ID).First(&organizerEP).Error)
	rp := addRoundPlayer(t, db, result.Round.ID, organizerEP.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rp.ID)

	// Set initial handicap=8 and enter two scores (hole 1 SI=1, hole 9 SI=9).
	// With handicap 8: strokes on SI 1–8, so hole 1 gets 1 stroke, hole 9 gets 0.
	require.NoError(t, db.Model(&rp).Update("course_handicap", 8).Error)
	_, err := svc.UpsertScores(context.Background(), result.Round.ID, rp.ID, organizer.ID, "user", []services.ScoreInput{
		{HoleNumber: 1, GrossScore: 5}, // net = 5 - 1 = 4
		{HoleNumber: 9, GrossScore: 5}, // net = 5 - 0 = 5
	})
	require.NoError(t, err)

	// Verify initial net scores.
	var before []models.Score
	require.NoError(t, db.Where("round_player_id = ?", rp.ID).Order("hole_number").Find(&before).Error)
	require.Len(t, before, 2)
	assert.Equal(t, 4, before[0].NetScore, "hole 1 net before handicap change")
	assert.Equal(t, 5, before[1].NetScore, "hole 9 net before handicap change")

	// Change handicap from 8 → 10. Now SI 1–10 each get a stroke.
	// hole 1 (SI=1): net = 5 - 1 = 4 (unchanged)
	// hole 9 (SI=9): net = 5 - 1 = 4 (was 5, now recalculated)
	err = svc.SetHandicap(context.Background(), result.Round.ID, rp.ID, organizer.ID, "user", 10)
	require.NoError(t, err)

	var after []models.Score
	require.NoError(t, db.Where("round_player_id = ?", rp.ID).Order("hole_number").Find(&after).Error)
	require.Len(t, after, 2)
	assert.Equal(t, 4, after[0].NetScore, "hole 1 net after handicap change")
	assert.Equal(t, 4, after[1].NetScore, "hole 9 net after handicap change — must update")
}

// ─── UpsertScores ─────────────────────────────────────────────────────────────

// TestScoreService_UpsertScores_Success verifies that scores are written with
// correct net scores derived from stroke_index and course_handicap.
func TestScoreService_UpsertScores_Success(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	course, tee := seedCourseWithTee(t, db, "UpsertScores Course")
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	var organizerEP models.EventPlayer
	require.NoError(t, db.Where("event_id = ? AND user_id = ?", event.ID, organizer.ID).First(&organizerEP).Error)
	rp := addRoundPlayer(t, db, result.Round.ID, organizerEP.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rp.ID)

	// Set handicap 18 — one stroke on every hole (SI 1–18 each gets one).
	require.NoError(t, db.Model(&rp).Update("course_handicap", 18).Error)

	// Holes 1 and 2, gross 5: SI=1 and SI=2 both ≤ 18 → net = 5-1 = 4.
	scores := []services.ScoreInput{
		{HoleNumber: 1, GrossScore: 5},
		{HoleNumber: 2, GrossScore: 5},
	}
	saved, err := svc.UpsertScores(context.Background(), result.Round.ID, rp.ID, organizer.ID, "user", scores)
	require.NoError(t, err)
	assert.Equal(t, 2, saved)

	var dbScores []models.Score
	require.NoError(t, db.Where("round_player_id = ?", rp.ID).Find(&dbScores).Error)
	require.Len(t, dbScores, 2)
	for _, sc := range dbScores {
		assert.Equal(t, 5, sc.GrossScore)
		assert.Equal(t, 4, sc.NetScore)
	}
}

// TestScoreService_UpsertScores_HandicapRequired verifies that score entry is
// blocked when the round requires a handicap and none is set.
func TestScoreService_UpsertScores_HandicapRequired(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	course, tee := seedCourseWithTee(t, db, "HCPRequired Course")
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	require.NoError(t, db.Model(&result.Round).Update("requires_handicap", true).Error)

	var organizerEP models.EventPlayer
	require.NoError(t, db.Where("event_id = ? AND user_id = ?", event.ID, organizer.ID).First(&organizerEP).Error)
	rp := addRoundPlayer(t, db, result.Round.ID, organizerEP.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rp.ID)

	_, err := svc.UpsertScores(context.Background(), result.Round.ID, rp.ID, organizer.ID, "user",
		[]services.ScoreInput{{HoleNumber: 1, GrossScore: 4}})
	assert.True(t, errors.Is(err, services.ErrHandicapRequired))
}

// TestScoreService_UpsertScores_Forbidden verifies that a player in a different
// group cannot submit scores for the target player.
func TestScoreService_UpsertScores_Forbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	outsider := seedUser(t, db, "outsider")
	target := seedUser(t, db, "target")
	course, tee := seedCourseWithTee(t, db, "Forbidden Scores Course")
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)

	epOutsider := addEventMember(t, db, event.ID, outsider.ID)
	epTarget := addEventMember(t, db, event.ID, target.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	rpOutsider := addRoundPlayer(t, db, result.Round.ID, epOutsider.ID)
	rpTarget := addRoundPlayer(t, db, result.Round.ID, epTarget.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rpOutsider.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 2, rpTarget.ID)

	activateRound(t, db, result.Round.ID)

	_, err := svc.UpsertScores(context.Background(), result.Round.ID, rpTarget.ID, outsider.ID, "user",
		[]services.ScoreInput{{HoleNumber: 1, GrossScore: 4}})
	assert.True(t, errors.Is(err, services.ErrScoreForbidden))
}

// TestScoreService_UpsertScores_CompletedRoundForbidden verifies that a non-organizer
// in the same group cannot submit scores after the round is marked completed.
func TestScoreService_UpsertScores_CompletedRoundForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	player := seedUser(t, db, "player")
	course, tee := seedCourseWithTee(t, db, "Completed Scores Course")
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)

	ep := addEventMember(t, db, event.ID, player.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	rp := addRoundPlayer(t, db, result.Round.ID, ep.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rp.ID)

	// Mark round completed.
	require.NoError(t, db.Model(&result.Round).Update("status", "completed").Error)

	_, err := svc.UpsertScores(context.Background(), result.Round.ID, rp.ID, player.ID, "user",
		[]services.ScoreInput{{HoleNumber: 1, GrossScore: 4}})
	assert.True(t, errors.Is(err, services.ErrRoundNotActive))
}

// TestScoreService_SetHandicap_CompletedRoundForbidden verifies that a non-organizer
// cannot set a handicap after the round is marked completed.
func TestScoreService_SetHandicap_CompletedRoundForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	player := seedUser(t, db, "player")
	course, tee := seedCourseWithTee(t, db, "Completed HCP Course")
	event := seedEvent(t, eventSvc, organizer.ID)

	ep := addEventMember(t, db, event.ID, player.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	rp := addRoundPlayer(t, db, result.Round.ID, ep.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rp.ID)

	require.NoError(t, db.Model(&result.Round).Update("status", "completed").Error)

	err := svc.SetHandicap(context.Background(), result.Round.ID, rp.ID, player.ID, "user", 10)
	assert.True(t, errors.Is(err, services.ErrRoundNotActive))
}

// TestScoreService_UpsertScores_ScheduledRoundForbidden verifies that a non-organizer
// in the same group cannot submit scores when the round has not yet been started.
func TestScoreService_UpsertScores_ScheduledRoundForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	player := seedUser(t, db, "player")
	course, tee := seedCourseWithTee(t, db, "Scheduled Scores Course")
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)

	ep := addEventMember(t, db, event.ID, player.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	rp := addRoundPlayer(t, db, result.Round.ID, ep.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rp.ID)

	// Round is still "scheduled" — no activateRound call.
	_, err := svc.UpsertScores(context.Background(), result.Round.ID, rp.ID, player.ID, "user",
		[]services.ScoreInput{{HoleNumber: 1, GrossScore: 4}})
	assert.True(t, errors.Is(err, services.ErrRoundNotActive))
}

// TestScoreService_OrganizerCanModifyCompletedRound verifies that the round organizer
// can still set scores on a completed round (to allow corrections).
func TestScoreService_OrganizerCanModifyCompletedRound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	course, tee := seedCourseWithTee(t, db, "Organizer Completed Course")
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	var organizerEP models.EventPlayer
	require.NoError(t, db.Where("event_id = ? AND user_id = ?", event.ID, organizer.ID).First(&organizerEP).Error)
	rp := addRoundPlayer(t, db, result.Round.ID, organizerEP.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rp.ID)

	require.NoError(t, db.Model(&result.Round).Update("status", "completed").Error)

	_, err := svc.UpsertScores(context.Background(), result.Round.ID, rp.ID, organizer.ID, "user",
		[]services.ScoreInput{{HoleNumber: 1, GrossScore: 4}})
	require.NoError(t, err, "organizer must be allowed to modify a completed round")
}

// TestScoreService_UpsertScores_Idempotent verifies that re-submitting a score
// overwrites the previous value rather than creating a duplicate row.
func TestScoreService_UpsertScores_Idempotent(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	course, tee := seedCourseWithTee(t, db, "Idempotent Course")
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	var organizerEP models.EventPlayer
	require.NoError(t, db.Where("event_id = ? AND user_id = ?", event.ID, organizer.ID).First(&organizerEP).Error)
	rp := addRoundPlayer(t, db, result.Round.ID, organizerEP.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rp.ID)

	_, err := svc.UpsertScores(context.Background(), result.Round.ID, rp.ID, organizer.ID, "user",
		[]services.ScoreInput{{HoleNumber: 1, GrossScore: 5}})
	require.NoError(t, err)

	_, err = svc.UpsertScores(context.Background(), result.Round.ID, rp.ID, organizer.ID, "user",
		[]services.ScoreInput{{HoleNumber: 1, GrossScore: 3}})
	require.NoError(t, err)

	var dbScores []models.Score
	require.NoError(t, db.Where("round_player_id = ?", rp.ID).Find(&dbScores).Error)
	require.Len(t, dbScores, 1, "re-submit must overwrite, not duplicate")
	assert.Equal(t, 3, dbScores[0].GrossScore)
}

// ─── UpsertHoleStats ──────────────────────────────────────────────────────────

// TestScoreService_UpsertHoleStats_Success verifies that stats are written and
// can be overwritten idempotently.
func TestScoreService_UpsertHoleStats_Success(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	course, tee := seedCourseWithTee(t, db, "HoleStat Course")
	event := seedEvent(t, eventSvc, organizer.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	var organizerEP models.EventPlayer
	require.NoError(t, db.Where("event_id = ? AND user_id = ?", event.ID, organizer.ID).First(&organizerEP).Error)
	rp := addRoundPlayer(t, db, result.Round.ID, organizerEP.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rp.ID)

	gir := "hit"
	saved, err := svc.UpsertHoleStats(context.Background(), result.Round.ID, rp.ID, organizer.ID, "user",
		[]services.HoleStatInput{{HoleNumber: 1, GIR: &gir}})
	require.NoError(t, err)
	assert.Equal(t, 1, saved)

	var dbStats []models.HoleStat
	require.NoError(t, db.Where("round_player_id = ?", rp.ID).Find(&dbStats).Error)
	require.Len(t, dbStats, 1)
	require.NotNil(t, dbStats[0].GIR)
	assert.Equal(t, "hit", *dbStats[0].GIR)
}

// TestScoreService_UpsertHoleStats_InvalidGIR verifies that the service rejects
// an unrecognised GIR value before any DB access (nil DB safe).
func TestScoreService_UpsertHoleStats_InvalidGIR(t *testing.T) {
	svc := services.NewScoreService(nil, nil)
	bad := "sideways"
	_, err := svc.UpsertHoleStats(context.Background(),
		uuid.New(), uuid.New(), uuid.New(), "user",
		[]services.HoleStatInput{{HoleNumber: 1, GIR: &bad}})
	var ve *services.ValidationError
	assert.True(t, errors.As(err, &ve), "expected ValidationError for invalid GIR")
}

// TestScoreService_UpsertHoleStats_AfterScores confirms that a player can save
// stats (GIR, putts) after all 18 hole scores have already been submitted — the
// reported bug scenario where stats silently failed post-score-entry.
func TestScoreService_UpsertHoleStats_AfterScores(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	course, tee := seedCourseWithTee(t, db, "AfterScores Course")
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	var organizerEP models.EventPlayer
	require.NoError(t, db.Where("event_id = ? AND user_id = ?", event.ID, organizer.ID).First(&organizerEP).Error)
	rp := addRoundPlayer(t, db, result.Round.ID, organizerEP.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rp.ID)

	// Step 1: submit all 18 scores (mirrors the user's reported pattern).
	scores := make([]services.ScoreInput, 18)
	for i := range scores {
		scores[i] = services.ScoreInput{HoleNumber: i + 1, GrossScore: 4}
	}
	saved, err := svc.UpsertScores(context.Background(), result.Round.ID, rp.ID, organizer.ID, "user", scores)
	require.NoError(t, err)
	assert.Equal(t, 18, saved)

	// Step 2: go back and add stats — this is the path that was silently failing.
	gir := "hit"
	putts := 2
	statsSaved, err := svc.UpsertHoleStats(context.Background(), result.Round.ID, rp.ID, organizer.ID, "user",
		[]services.HoleStatInput{{HoleNumber: 1, GIR: &gir, Putts: &putts}})
	require.NoError(t, err)
	assert.Equal(t, 1, statsSaved)

	var dbStats []models.HoleStat
	require.NoError(t, db.Where("round_player_id = ?", rp.ID).Find(&dbStats).Error)
	require.Len(t, dbStats, 1)
	require.NotNil(t, dbStats[0].GIR)
	assert.Equal(t, "hit", *dbStats[0].GIR)
	require.NotNil(t, dbStats[0].Putts)
	assert.Equal(t, 2, *dbStats[0].Putts)
}

// ─── GetScorecard ─────────────────────────────────────────────────────────────

// TestScoreService_GetScorecard_Success verifies that the scorecard is assembled
// with holes, groups, players, and scores from the DB.
func TestScoreService_GetScorecard_Success(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)
	eventSvc := services.NewEventService(db)
	roundSvc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	course, tee := seedCourseWithTee(t, db, "Scorecard Course")
	seedHoles(t, db, tee.ID)
	event := seedEvent(t, eventSvc, organizer.ID)
	cStr, tStr := course.ID.String(), tee.ID.String()
	result := scheduleRound(t, roundSvc, event.ID, organizer.ID, cStr, tStr)

	var organizerEP models.EventPlayer
	require.NoError(t, db.Where("event_id = ? AND user_id = ?", event.ID, organizer.ID).First(&organizerEP).Error)
	rp := addRoundPlayer(t, db, result.Round.ID, organizerEP.ID)
	addGroupWithPlayer(t, db, result.Round.ID, 1, rp.ID)

	require.NoError(t, db.Create(&models.Score{
		RoundPlayerID: rp.ID, HoleNumber: 1, GrossScore: 4, NetScore: 4, EnteredBy: organizer.ID,
	}).Error)

	data, err := svc.GetScorecard(context.Background(), result.Round.ID, organizer.ID, "user")
	require.NoError(t, err)
	require.NotNil(t, data)
	assert.Equal(t, result.Round.ID.String(), data.RoundID)
	assert.True(t, data.IsOrganizer, "event creator should be organizer")
	assert.Len(t, data.Holes, 18)
	require.Len(t, data.Groups, 1)
	require.Len(t, data.Groups[0].Players, 1)
	assert.Len(t, data.Groups[0].Players[0].Scores, 1)
	assert.Equal(t, 4, data.Groups[0].Players[0].Scores[0].GrossScore)
}

// TestScoreService_GetScorecard_RoundNotFound verifies that a missing round
// returns ErrRoundNotFound.
func TestScoreService_GetScorecard_RoundNotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := newScoreSvc(db)

	_, err := svc.GetScorecard(context.Background(), uuid.New(), uuid.New(), "user")
	assert.True(t, errors.Is(err, services.ErrRoundNotFound))
}
