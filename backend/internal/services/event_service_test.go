// services/event_service_test.go
// Integration tests for EventService. Uses testutil.NewTestDB to spin up an
// ephemeral Postgres container — no setup required beyond Docker running.
//
// Tier 1 paths (validation that returns before any DB call) are covered by
// the handler tests in handlers/events_test.go via the writeEventError helper.
// Everything here is Tier 2: real DB, real transactions, real constraints.
package services_test

import (
	"context"
	"errors"
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// seedUser inserts a user and returns it. Email is derived from suffix to
// keep emails unique across multi-user fixtures in the same test.
func seedUser(t *testing.T, db *gorm.DB, suffix string) models.User {
	t.Helper()
	u := models.User{
		Email:       suffix + "@test.local",
		DisplayName: suffix,
		Role:        models.UserRole("user"),
	}
	require.NoError(t, db.Create(&u).Error)
	return u
}

// seedAdmin inserts a user with the admin global role.
func seedAdmin(t *testing.T, db *gorm.DB) models.User {
	t.Helper()
	u := models.User{
		Email:       "admin@test.local",
		DisplayName: "Admin",
		Role:        models.UserRole("admin"),
	}
	require.NoError(t, db.Create(&u).Error)
	return u
}

// createEventViaService runs the service's Create path (so the creator is
// auto-added as organizer) and returns the resulting event.
func createEventViaService(t *testing.T, svc *services.EventService, creator uuid.UUID, name string) models.Event {
	t.Helper()
	item, err := svc.Create(context.Background(), services.CreateEventInput{
		Name:      name,
		EventType: "league",
		CreatedBy: creator,
	})
	require.NoError(t, err)
	return item.Event
}

// ─── IsOrganizer ──────────────────────────────────────────────────────────────

func TestEventService_IsOrganizer_AdminAlwaysTrue(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)

	// Admin gets true even without an event_player row — no DB hit needed.
	got, err := svc.IsOrganizer(context.Background(), uuid.New(), uuid.New(), "admin")
	require.NoError(t, err)
	assert.True(t, got)
}

func TestEventService_IsOrganizer_OrganizerRowReturnsTrue(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L1")

	got, err := svc.IsOrganizer(context.Background(), event.ID, creator.ID, "user")
	require.NoError(t, err)
	assert.True(t, got)
}

func TestEventService_IsOrganizer_PlayerRoleReturnsFalse(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	other := seedUser(t, db, "other")
	event := createEventViaService(t, svc, creator.ID, "L1")
	_, err := svc.AddMember(context.Background(), event.ID, creator.ID, "user", other.ID)
	require.NoError(t, err)

	got, err := svc.IsOrganizer(context.Background(), event.ID, other.ID, "user")
	require.NoError(t, err)
	assert.False(t, got, "default-added members get role=player, not organizer")
}

func TestEventService_IsOrganizer_NonMemberReturnsFalse(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L1")
	stranger := seedUser(t, db, "stranger")

	got, err := svc.IsOrganizer(context.Background(), event.ID, stranger.ID, "user")
	require.NoError(t, err)
	assert.False(t, got)
}

// ─── Create ──────────────────────────────────────────────────────────────────

func TestEventService_Create_Validation(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	u := seedUser(t, db, "u")

	cases := []struct {
		name string
		in   services.CreateEventInput
	}{
		{"missing name", services.CreateEventInput{EventType: "league", CreatedBy: u.ID}},
		{"whitespace name", services.CreateEventInput{Name: "   ", EventType: "league", CreatedBy: u.ID}},
		{"bad event type", services.CreateEventInput{Name: "X", EventType: "robot", CreatedBy: u.ID}},
		{"bad start date", services.CreateEventInput{Name: "X", EventType: "league", StartDate: ptrString("nope"), CreatedBy: u.ID}},
		{"bad end date", services.CreateEventInput{Name: "X", EventType: "league", EndDate: ptrString("nope"), CreatedBy: u.ID}},
		{"allowance too high", services.CreateEventInput{Name: "X", EventType: "league", HandicapAllowance: ptrFloat64(150), CreatedBy: u.ID}},
		{"allowance negative", services.CreateEventInput{Name: "X", EventType: "league", HandicapAllowance: ptrFloat64(-1), CreatedBy: u.ID}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.Create(context.Background(), tc.in)
			var ve *services.ValidationError
			assert.ErrorAs(t, err, &ve, "expected ValidationError, got %v", err)
		})
	}
}

func TestEventService_Create_AutoAddsCreatorAsOrganizer(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")

	item, err := svc.Create(context.Background(), services.CreateEventInput{
		Name:      "  My League  ", // gets trimmed
		EventType: "league",
		CreatedBy: creator.ID,
	})
	require.NoError(t, err)
	assert.Equal(t, "My League", item.Event.Name)
	assert.Equal(t, models.EventStatusActive, item.Event.Status)
	assert.Equal(t, int64(1), item.MemberCount)

	// Creator must be on event_players with role=organizer for IsOrganizer to be true.
	got, err := svc.IsOrganizer(context.Background(), item.Event.ID, creator.ID, "user")
	require.NoError(t, err)
	assert.True(t, got, "Create must atomically add the creator as organizer")
}

// ─── List ─────────────────────────────────────────────────────────────────────

func TestEventService_List_AdminSeesAll(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	a := seedUser(t, db, "a")
	b := seedUser(t, db, "b")
	createEventViaService(t, svc, a.ID, "A")
	createEventViaService(t, svc, b.ID, "B")
	admin := seedAdmin(t, db)

	got, err := svc.List(context.Background(), services.ListEventsFilters{
		UserID:   admin.ID,
		UserRole: "admin",
	})
	require.NoError(t, err)
	assert.Len(t, got, 2)
}

func TestEventService_List_NonAdminSeesOnlyTheirEvents(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	a := seedUser(t, db, "a")
	b := seedUser(t, db, "b")
	createEventViaService(t, svc, a.ID, "A's league")
	createEventViaService(t, svc, b.ID, "B's league")

	got, err := svc.List(context.Background(), services.ListEventsFilters{
		UserID:   a.ID,
		UserRole: "user",
	})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "A's league", got[0].Event.Name)
	assert.Equal(t, int64(1), got[0].MemberCount)
}

func TestEventService_List_TypeFilter(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	require.NoError(t, db.Save(&creator).Error)

	_, err := svc.Create(context.Background(), services.CreateEventInput{
		Name: "L", EventType: "league", CreatedBy: creator.ID,
	})
	require.NoError(t, err)
	_, err = svc.Create(context.Background(), services.CreateEventInput{
		Name: "T", EventType: "tournament", CreatedBy: creator.ID,
	})
	require.NoError(t, err)

	got, err := svc.List(context.Background(), services.ListEventsFilters{
		UserID:   creator.ID,
		UserRole: "user",
		Type:     "tournament",
	})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "T", got[0].Event.Name)
}

// ─── Get ──────────────────────────────────────────────────────────────────────

func TestEventService_Get_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	u := seedUser(t, db, "u")

	_, err := svc.Get(context.Background(), uuid.New(), u.ID, "user")
	assert.ErrorIs(t, err, services.ErrEventNotFound)
}

func TestEventService_Get_NonMemberForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	stranger := seedUser(t, db, "stranger")
	event := createEventViaService(t, svc, creator.ID, "L")

	_, err := svc.Get(context.Background(), event.ID, stranger.ID, "user")
	assert.ErrorIs(t, err, services.ErrEventNotMember)
}

func TestEventService_Get_AdminCanReadAny(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	admin := seedAdmin(t, db)
	event := createEventViaService(t, svc, creator.ID, "L")

	detail, err := svc.Get(context.Background(), event.ID, admin.ID, "admin")
	require.NoError(t, err)
	assert.Equal(t, event.ID, detail.Event.ID)
	assert.Equal(t, int64(1), detail.MemberCount)
	require.Len(t, detail.Members, 1)
	assert.Equal(t, creator.ID, detail.Members[0].User.ID)
}

func TestEventService_Get_MemberCanRead(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L")

	detail, err := svc.Get(context.Background(), event.ID, creator.ID, "user")
	require.NoError(t, err)
	assert.Equal(t, "L", detail.Event.Name)
	require.Len(t, detail.Members, 1)
}

// ─── Update ──────────────────────────────────────────────────────────────────

func TestEventService_Update_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	u := seedUser(t, db, "u")

	_, err := svc.Update(context.Background(), uuid.New(), u.ID, "user", services.UpdateEventInput{})
	assert.ErrorIs(t, err, services.ErrEventNotFound)
}

func TestEventService_Update_NotOrganizerForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	stranger := seedUser(t, db, "stranger")
	event := createEventViaService(t, svc, creator.ID, "L")

	newName := "Renamed"
	_, err := svc.Update(context.Background(), event.ID, stranger.ID, "user", services.UpdateEventInput{
		Name: &newName,
	})
	assert.ErrorIs(t, err, services.ErrEventForbidden)
}

func TestEventService_Update_PatchesFields(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L")

	newName := "Renamed"
	newStatus := "completed"
	allowance := 90.0
	startDate := "2026-06-01"

	result, err := svc.Update(context.Background(), event.ID, creator.ID, "user", services.UpdateEventInput{
		Name:              &newName,
		Status:            &newStatus,
		HandicapAllowance: &allowance,
		StartDate:         &startDate,
	})
	require.NoError(t, err)
	assert.Equal(t, "Renamed", result.Event.Name)
	assert.Equal(t, models.EventStatusCompleted, result.Event.Status)
	require.NotNil(t, result.Event.HandicapAllowance)
	assert.Equal(t, 90.0, *result.Event.HandicapAllowance)
	require.NotNil(t, result.Event.StartDate)
	assert.True(t, result.AllowanceChanged, "handler uses this flag to decide whether to recalc scores")
	assert.True(t, result.StatusChanged)
}

func TestEventService_Update_ClearStartDate(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")

	startDate := "2026-06-01"
	item, err := svc.Create(context.Background(), services.CreateEventInput{
		Name: "L", EventType: "league", CreatedBy: creator.ID, StartDate: &startDate,
	})
	require.NoError(t, err)
	require.NotNil(t, item.Event.StartDate)

	cleared := ""
	result, err := svc.Update(context.Background(), item.Event.ID, creator.ID, "user", services.UpdateEventInput{
		StartDate: &cleared,
	})
	require.NoError(t, err)
	assert.Nil(t, result.Event.StartDate, "empty string clears the date")
}

func TestEventService_Update_BadStatus(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L")

	bad := "robot"
	_, err := svc.Update(context.Background(), event.ID, creator.ID, "user", services.UpdateEventInput{
		Status: &bad,
	})
	var ve *services.ValidationError
	assert.ErrorAs(t, err, &ve)
}

func TestEventService_Update_AllowanceUnchanged_FlagFalse(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L")

	newName := "Renamed"
	result, err := svc.Update(context.Background(), event.ID, creator.ID, "user", services.UpdateEventInput{
		Name: &newName,
	})
	require.NoError(t, err)
	assert.False(t, result.AllowanceChanged, "no allowance in input → flag stays false → handler skips recalc")
}

// ─── Delete ──────────────────────────────────────────────────────────────────

func TestEventService_Delete_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	u := seedUser(t, db, "u")

	err := svc.Delete(context.Background(), uuid.New(), u.ID, "user")
	assert.ErrorIs(t, err, services.ErrEventNotFound)
}

func TestEventService_Delete_NotOrganizerForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	stranger := seedUser(t, db, "stranger")
	event := createEventViaService(t, svc, creator.ID, "L")

	err := svc.Delete(context.Background(), event.ID, stranger.ID, "user")
	assert.ErrorIs(t, err, services.ErrEventForbidden)
}

func TestEventService_Delete_OrganizerSucceeds(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L")

	require.NoError(t, svc.Delete(context.Background(), event.ID, creator.ID, "user"))

	var count int64
	require.NoError(t, db.Model(&models.Event{}).Where("id = ?", event.ID).Count(&count).Error)
	assert.Zero(t, count)
}

// ─── Members ──────────────────────────────────────────────────────────────────

func TestEventService_AddMember_NotOrganizerForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	stranger := seedUser(t, db, "stranger")
	target := seedUser(t, db, "target")
	event := createEventViaService(t, svc, creator.ID, "L")

	_, err := svc.AddMember(context.Background(), event.ID, stranger.ID, "user", target.ID)
	assert.ErrorIs(t, err, services.ErrEventForbidden)
}

func TestEventService_AddMember_TargetUserNotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L")

	_, err := svc.AddMember(context.Background(), event.ID, creator.ID, "user", uuid.New())
	assert.ErrorIs(t, err, services.ErrUserNotFound)
}

func TestEventService_AddMember_AlreadyMember(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L")

	// Creator is already an organizer, so adding them again should conflict.
	_, err := svc.AddMember(context.Background(), event.ID, creator.ID, "user", creator.ID)
	assert.ErrorIs(t, err, services.ErrMemberAlreadyExists)
}

func TestEventService_AddMember_AddsAsPlayer(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	target := seedUser(t, db, "target")
	event := createEventViaService(t, svc, creator.ID, "L")

	got, err := svc.AddMember(context.Background(), event.ID, creator.ID, "user", target.ID)
	require.NoError(t, err)
	assert.Equal(t, target.ID, got.User.ID)
	assert.Equal(t, models.EventPlayerRolePlayer, got.Player.Role)
	assert.Equal(t, models.EventPlayerStatusRegistered, got.Player.Status)
}

func TestEventService_RemoveMember_NotOrganizerForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	stranger := seedUser(t, db, "stranger")
	event := createEventViaService(t, svc, creator.ID, "L")

	err := svc.RemoveMember(context.Background(), event.ID, stranger.ID, "user", creator.ID)
	assert.ErrorIs(t, err, services.ErrEventForbidden)
}

func TestEventService_RemoveMember_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L")

	err := svc.RemoveMember(context.Background(), event.ID, creator.ID, "user", uuid.New())
	assert.ErrorIs(t, err, services.ErrMemberNotFound)
}

func TestEventService_RemoveMember_LastOrganizerBlocked(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator") // sole organizer
	event := createEventViaService(t, svc, creator.ID, "L")

	// Use admin as caller so the IsOrganizer check passes — the guard should
	// still fire because there's only one organizer left on the event.
	admin := seedAdmin(t, db)

	err := svc.RemoveMember(context.Background(), event.ID, admin.ID, "admin", creator.ID)
	if !errors.Is(err, services.ErrLastOrganizer) {
		t.Fatalf("expected ErrLastOrganizer, got: %v", err)
	}
}

func TestEventService_RemoveMember_NonOrganizerOK(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	target := seedUser(t, db, "target")
	event := createEventViaService(t, svc, creator.ID, "L")
	_, err := svc.AddMember(context.Background(), event.ID, creator.ID, "user", target.ID)
	require.NoError(t, err)

	// Removing a player (not the last organizer) should succeed.
	require.NoError(t, svc.RemoveMember(context.Background(), event.ID, creator.ID, "user", target.ID))

	var count int64
	require.NoError(t, db.Model(&models.EventPlayer{}).
		Where("event_id = ? AND user_id = ?", event.ID, target.ID).
		Count(&count).Error)
	assert.Zero(t, count)
}

// ─── GetMembers / GetRounds ───────────────────────────────────────────────────

func TestEventService_GetMembers_OrderingAndShape(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	target := seedUser(t, db, "target")
	event := createEventViaService(t, svc, creator.ID, "L")
	_, err := svc.AddMember(context.Background(), event.ID, creator.ID, "user", target.ID)
	require.NoError(t, err)

	got, err := svc.GetMembers(context.Background(), event.ID)
	require.NoError(t, err)
	assert.Len(t, got, 2)
	// Each member item carries the joined User row (display name etc.) for the handler.
	for _, m := range got {
		assert.NotEmpty(t, m.User.DisplayName)
		assert.NotEmpty(t, m.User.Email)
	}
}

func TestEventService_GetRounds_EmptyAndPopulated(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L")

	rounds, err := svc.GetRounds(context.Background(), event.ID)
	require.NoError(t, err)
	assert.Empty(t, rounds, "no rounds yet → empty slice, not nil")

	// Insert a round directly so we can exercise the populated branch without
	// pulling in the full ScheduleEventRound machinery.
	course := models.Course{Name: "Pebble", HoleCount: 18}
	require.NoError(t, db.Create(&course).Error)
	tee := models.Tee{
		CourseID:     course.ID,
		Name:         "Blue",
		Gender:       models.TeeGenderUnisex,
		CourseRating: 72.4, SlopeRating: 130, Par: 72,
	}
	require.NoError(t, db.Create(&tee).Error)
	eid := event.ID
	round := models.Round{
		EventID:       &eid,
		CourseID:      course.ID,
		DefaultTeeID:  tee.ID,
		Name:          "Round 1",
		RoundNumber:   1,
		ScheduledDate: time.Now(),
		Status:        models.RoundStatusScheduled,
		ScoringFormat: models.ScoringFormatStroke,
	}
	require.NoError(t, db.Create(&round).Error)
	require.NoError(t, db.Create(&models.Group{
		RoundID: round.ID, GroupNumber: 1, StartingHole: 1,
	}).Error)

	rounds, err = svc.GetRounds(context.Background(), event.ID)
	require.NoError(t, err)
	require.Len(t, rounds, 1)
	assert.Equal(t, "Pebble", rounds[0].CourseName)
	assert.Equal(t, 1, rounds[0].GroupCount)
}

// ─── ListPublic ───────────────────────────────────────────────────────────────

func TestEventService_ListPublic_OnlyReturnsPublicEvents(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	stranger := seedUser(t, db, "stranger")

	// Create one public and one private event.
	pub, err := svc.Create(context.Background(), services.CreateEventInput{
		Name: "Public League", EventType: "league", IsPublic: true, CreatedBy: creator.ID,
	})
	require.NoError(t, err)
	_, err = svc.Create(context.Background(), services.CreateEventInput{
		Name: "Private League", EventType: "league", IsPublic: false, CreatedBy: creator.ID,
	})
	require.NoError(t, err)

	got, err := svc.ListPublic(context.Background(), stranger.ID)
	require.NoError(t, err)
	require.Len(t, got, 1, "only the public event should be returned")
	assert.Equal(t, pub.Event.ID, got[0].Event.ID)
}

func TestEventService_ListPublic_ExcludesAlreadyMember(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")

	// Creator is auto-added as organizer — so they are already a member.
	_, err := svc.Create(context.Background(), services.CreateEventInput{
		Name: "Public League", EventType: "league", IsPublic: true, CreatedBy: creator.ID,
	})
	require.NoError(t, err)

	got, err := svc.ListPublic(context.Background(), creator.ID)
	require.NoError(t, err)
	assert.Empty(t, got, "creator is already a member and should be excluded")
}

// ─── RequestJoin ──────────────────────────────────────────────────────────────

func TestEventService_RequestJoin_CreatesRow(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	requester := seedUser(t, db, "requester")

	event, err := svc.Create(context.Background(), services.CreateEventInput{
		Name: "Open League", EventType: "league", IsPublic: true, CreatedBy: creator.ID,
	})
	require.NoError(t, err)

	err = svc.RequestJoin(context.Background(), event.Event.ID, requester.ID)
	require.NoError(t, err)

	var player models.EventPlayer
	err = db.Where("event_id = ? AND user_id = ?", event.Event.ID, requester.ID).First(&player).Error
	require.NoError(t, err)
	assert.Equal(t, models.EventPlayerStatusPending, player.Status)
	assert.Equal(t, models.EventPlayerRolePlayer, player.Role)
}

func TestEventService_RequestJoin_PrivateEventFails(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	requester := seedUser(t, db, "requester")

	event, err := svc.Create(context.Background(), services.CreateEventInput{
		Name: "Closed League", EventType: "league", IsPublic: false, CreatedBy: creator.ID,
	})
	require.NoError(t, err)

	err = svc.RequestJoin(context.Background(), event.Event.ID, requester.ID)
	assert.ErrorIs(t, err, services.ErrEventNotPublic)
}

func TestEventService_RequestJoin_AlreadyMemberFails(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")

	event, err := svc.Create(context.Background(), services.CreateEventInput{
		Name: "Open League", EventType: "league", IsPublic: true, CreatedBy: creator.ID,
	})
	require.NoError(t, err)

	// Creator is already a member — requesting join should fail.
	err = svc.RequestJoin(context.Background(), event.Event.ID, creator.ID)
	assert.ErrorIs(t, err, services.ErrMemberAlreadyExists)
}

// ─── ListJoinRequests ─────────────────────────────────────────────────────────

func TestEventService_ListJoinRequests_NotOrganizerForbidden(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	stranger := seedUser(t, db, "stranger")

	event := createEventViaService(t, svc, creator.ID, "L")

	_, err := svc.ListJoinRequests(context.Background(), event.ID, stranger.ID, "user")
	assert.ErrorIs(t, err, services.ErrEventForbidden)
}

func TestEventService_ListJoinRequests_ReturnsPending(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	requester := seedUser(t, db, "requester")

	event, err := svc.Create(context.Background(), services.CreateEventInput{
		Name: "Open League", EventType: "league", IsPublic: true, CreatedBy: creator.ID,
	})
	require.NoError(t, err)
	err = svc.RequestJoin(context.Background(), event.Event.ID, requester.ID)
	require.NoError(t, err)

	items, err := svc.ListJoinRequests(context.Background(), event.Event.ID, creator.ID, "user")
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, requester.ID, items[0].User.ID)
	assert.Equal(t, models.EventPlayerStatusPending, items[0].Player.Status)
}

// ─── HandleJoinRequest ────────────────────────────────────────────────────────

func TestEventService_HandleJoinRequest_Approve(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	requester := seedUser(t, db, "requester")

	event, err := svc.Create(context.Background(), services.CreateEventInput{
		Name: "Open League", EventType: "league", IsPublic: true, CreatedBy: creator.ID,
	})
	require.NoError(t, err)
	require.NoError(t, svc.RequestJoin(context.Background(), event.Event.ID, requester.ID))

	err = svc.HandleJoinRequest(context.Background(), event.Event.ID, creator.ID, "user", requester.ID, true)
	require.NoError(t, err)

	var player models.EventPlayer
	require.NoError(t, db.Where("event_id = ? AND user_id = ?", event.Event.ID, requester.ID).First(&player).Error)
	assert.Equal(t, models.EventPlayerStatusRegistered, player.Status)
}

func TestEventService_HandleJoinRequest_Deny(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	requester := seedUser(t, db, "requester")

	event, err := svc.Create(context.Background(), services.CreateEventInput{
		Name: "Open League", EventType: "league", IsPublic: true, CreatedBy: creator.ID,
	})
	require.NoError(t, err)
	require.NoError(t, svc.RequestJoin(context.Background(), event.Event.ID, requester.ID))

	err = svc.HandleJoinRequest(context.Background(), event.Event.ID, creator.ID, "user", requester.ID, false)
	require.NoError(t, err)

	var count int64
	db.Model(&models.EventPlayer{}).Where("event_id = ? AND user_id = ?", event.Event.ID, requester.ID).Count(&count)
	assert.Zero(t, count, "denied request row should be deleted")
}

func TestEventService_HandleJoinRequest_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	stranger := seedUser(t, db, "stranger")
	event := createEventViaService(t, svc, creator.ID, "L")

	err := svc.HandleJoinRequest(context.Background(), event.ID, creator.ID, "user", stranger.ID, true)
	assert.ErrorIs(t, err, services.ErrJoinRequestNotFound)
}

// ─── UpdateMemberRole ─────────────────────────────────────────────────────────

func TestEventService_UpdateMemberRole_PromoteToOrganizer(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	member := seedUser(t, db, "member")
	event := createEventViaService(t, svc, creator.ID, "L")

	_, err := svc.AddMember(context.Background(), event.ID, creator.ID, "user", member.ID)
	require.NoError(t, err)

	err = svc.UpdateMemberRole(context.Background(), event.ID, creator.ID, "user", member.ID, "organizer")
	require.NoError(t, err)

	var player models.EventPlayer
	require.NoError(t, db.Where("event_id = ? AND user_id = ?", event.ID, member.ID).First(&player).Error)
	assert.Equal(t, models.EventPlayerRoleOrganizer, player.Role)
}

func TestEventService_UpdateMemberRole_CannotDemoteLastOrganizer(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L")

	// Creator is the only organizer — demoting should fail.
	err := svc.UpdateMemberRole(context.Background(), event.ID, creator.ID, "user", creator.ID, "player")
	assert.ErrorIs(t, err, services.ErrLastOrganizer)
}

func TestEventService_UpdateMemberRole_MemberNotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewEventService(db)
	creator := seedUser(t, db, "creator")
	event := createEventViaService(t, svc, creator.ID, "L")

	err := svc.UpdateMemberRole(context.Background(), event.ID, creator.ID, "user", uuid.New(), "organizer")
	assert.ErrorIs(t, err, services.ErrMemberNotFound)
}

// ─── Local helpers ────────────────────────────────────────────────────────────

func ptrString(s string) *string    { return &s }
func ptrFloat64(f float64) *float64 { return &f }
