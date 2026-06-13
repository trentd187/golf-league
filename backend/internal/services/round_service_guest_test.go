// services/round_service_guest_test.go
// Tier 2 integration tests for guest players: AddGuestToGroup and guest-aware
// removal. Uses testutil.NewTestDB (ephemeral Postgres) — Docker must be running.
//
// A guest is a lightweight users row (is_guest=true, no auth_id, synthetic email)
// that joins a round directly via round_players with event_player_id NULL — even
// on event-linked rounds — and slots into the existing group/team pipeline.
package services_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/services"
	"github.com/trentd187/golf-league/internal/testutil"
)

func TestRoundService_AddGuestToGroup_HappyPath(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "orgGuest1")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Guest Course 1")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	hcp := 12
	result, err := svc.AddGuestToGroup(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, "user", "  Sandbagger Sam  ", &hcp)
	require.NoError(t, err)
	require.Len(t, result.Players, 1)
	assert.Equal(t, "Sandbagger Sam", result.Players[0].DisplayName) // trimmed
	assert.True(t, result.Players[0].IsGuest)

	// The guest users row exists with is_guest=true and no auth_id.
	var guest models.User
	require.NoError(t, db.First(&guest, "id = ?", result.Players[0].UserID).Error)
	assert.True(t, guest.IsGuest)
	assert.Nil(t, guest.AuthID)
	assert.NotEmpty(t, guest.Email) // synthetic, satisfies NOT NULL/UNIQUE

	// The round_player has event_player_id NULL even though this is an event round,
	// and carries the optional course handicap.
	var rp models.RoundPlayer
	require.NoError(t, db.First(&rp, "id = ?", result.Players[0].RoundPlayerID).Error)
	assert.Nil(t, rp.EventPlayerID)
	require.NotNil(t, rp.CourseHandicap)
	assert.Equal(t, 12, *rp.CourseHandicap)
}

func TestRoundService_AddGuestToGroup_BlankNameRejected(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "orgGuest2")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Guest Course 2")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	_, err := svc.AddGuestToGroup(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, "user", "   ", nil)
	var ve *services.ValidationError
	require.ErrorAs(t, err, &ve)
	assert.Equal(t, "name is required", ve.Message)
}

func TestRoundService_AddGuestToGroup_NameTooLongRejected(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "orgGuest2b")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Guest Course 2b")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	longName := ""
	for i := 0; i < 81; i++ {
		longName += "x"
	}
	_, err := svc.AddGuestToGroup(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, "user", longName, nil)
	var ve *services.ValidationError
	require.ErrorAs(t, err, &ve)
	assert.Equal(t, "name must be 80 characters or fewer", ve.Message)
}

func TestRoundService_AddGuestToGroup_RoundNotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))

	_, err := svc.AddGuestToGroup(context.Background(), uuid.New(), uuid.New(), uuid.New(), "user", "Guest", nil)
	assert.ErrorIs(t, err, services.ErrRoundNotFound)
}

func TestRoundService_AddGuestToGroup_GroupNotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "orgGuest2c")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Guest Course 2c")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	_, err := svc.AddGuestToGroup(context.Background(), scheduled.Round.ID, uuid.New(), organizer.ID, "user", "Guest", nil)
	assert.ErrorIs(t, err, services.ErrGroupNotFound)
}

func TestRoundService_AddGuestToGroup_ForbiddenForNonOrganizer(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "orgGuest3")
	stranger := seedUser(t, db, "strangerGuest3")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Guest Course 3")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	_, err := svc.AddGuestToGroup(context.Background(), scheduled.Round.ID, group.ID, stranger.ID, "user", "Guest", nil)
	assert.ErrorIs(t, err, services.ErrRoundForbidden)
}

func TestRoundService_AddGuestToGroup_GroupFullReturnsError(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "orgGuest4")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Guest Course 4")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	// Fill the group with 4 guests.
	for i := 0; i < 4; i++ {
		_, err := svc.AddGuestToGroup(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, "user", "Guest", nil)
		require.NoError(t, err, "guest %d should be added", i+1)
	}

	// A 5th guest should be rejected.
	_, err := svc.AddGuestToGroup(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, "user", "Guest", nil)
	assert.ErrorIs(t, err, services.ErrGroupFull)
}

func TestRoundService_RemoveGuest_DeletesGuestUser(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "orgGuest5")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Guest Course 5")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	added, err := svc.AddGuestToGroup(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, "user", "Guest", nil)
	require.NoError(t, err)
	guestID, err := uuid.Parse(added.Players[0].UserID)
	require.NoError(t, err)

	// Removal uses the guest's user_id as the :userId path param.
	require.NoError(t, svc.RemoveGroupMember(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, guestID, "user"))

	// Round player and the orphan guest user are both gone.
	var rpCount, userCount int64
	db.Model(&models.RoundPlayer{}).Where("user_id = ?", guestID).Count(&rpCount)
	db.Model(&models.User{}).Where("id = ?", guestID).Count(&userCount)
	assert.Equal(t, int64(0), rpCount)
	assert.Equal(t, int64(0), userCount)
}

func TestRoundService_AddGuestToGroup_AssignableToVegasTeam(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "orgGuest6")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Guest Course 6")
	scheduled := scheduleVegasRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String(), nil, nil)

	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	g1, err := svc.AddGuestToGroup(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, "user", "Guest One", nil)
	require.NoError(t, err)
	g2, err := svc.AddGuestToGroup(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, "user", "Guest Two", nil)
	require.NoError(t, err)

	rp1, err := uuid.Parse(g1.Players[len(g1.Players)-1].RoundPlayerID)
	require.NoError(t, err)
	rp2, err := uuid.Parse(g2.Players[len(g2.Players)-1].RoundPlayerID)
	require.NoError(t, err)

	team, err := svc.CreateTeam(context.Background(), scheduled.Round.ID, organizer.ID, "user", "Team A")
	require.NoError(t, err)
	result, err := svc.AssignTeamMembers(context.Background(), scheduled.Round.ID, team.Team.ID, organizer.ID, "user", []uuid.UUID{rp1, rp2})
	require.NoError(t, err)
	assert.Len(t, result.Members, 2)
	for _, m := range result.Members {
		assert.True(t, m.IsGuest)
	}
}
