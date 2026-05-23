// services/round_service_test.go
// Integration tests for RoundService. Uses testutil.NewTestDB to spin up an
// ephemeral Postgres container — Docker must be running.
//
// Tier 1 paths (validation that returns before any DB call) are covered by
// the handler tests in handlers/rounds_test.go via writeRoundError.
// Everything here is Tier 2: real DB, real transactions, real constraints.
//
// Do NOT call t.Parallel() — TRUNCATE is global across the shared container.
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

// seedCourseWithTee inserts a named course with one default tee and returns both.
func seedCourseWithTee(t *testing.T, db *gorm.DB, name string) (models.Course, models.Tee) {
	t.Helper()
	course := models.Course{Name: name, HoleCount: 18}
	require.NoError(t, db.Create(&course).Error)
	tee := models.Tee{
		CourseID:     course.ID,
		Name:         "White",
		Gender:       models.TeeGenderUnisex,
		CourseRating: 72.0,
		SlopeRating:  113,
		Par:          72,
	}
	require.NoError(t, db.Create(&tee).Error)
	return course, tee
}

// seedEvent creates an event with the organizer auto-added, using EventService
// so the creator gets the organizer event_player row.
func seedEvent(t *testing.T, svc *services.EventService, creatorID uuid.UUID) models.Event {
	t.Helper()
	item, err := svc.Create(context.Background(), services.CreateEventInput{
		Name:      "Test Event",
		EventType: "casual",
		CreatedBy: creatorID,
	})
	require.NoError(t, err)
	return item.Event
}

// addEventMember directly inserts an event_player row for a non-organizer member.
func addEventMember(t *testing.T, db *gorm.DB, eventID, userID uuid.UUID) models.EventPlayer {
	t.Helper()
	ep := models.EventPlayer{
		EventID: eventID,
		UserID:  userID,
		Role:    models.EventPlayerRolePlayer,
		Status:  models.EventPlayerStatusRegistered,
	}
	require.NoError(t, db.Create(&ep).Error)
	return ep
}

// scheduleRound schedules a round via the service and returns it.
func scheduleRound(t *testing.T, svc *services.RoundService, eventID, callerID uuid.UUID, courseID, teeID string) services.ScheduleRoundResult {
	t.Helper()
	result, err := svc.Schedule(context.Background(), eventID, callerID, "user", services.ScheduleRoundInput{
		ScheduledDate: time.Now().UTC().Format("2006-01-02"),
		CourseID:      &courseID,
		DefaultTeeID:  &teeID,
	})
	require.NoError(t, err)
	return result
}

// ─── IsRoundOrganizer ─────────────────────────────────────────────────────────

func TestRoundService_IsRoundOrganizer_AdminAlwaysTrue(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	// Seed a real round so the admin path (after DB lookup) can be verified.
	organizer := seedUser(t, db, "orgAdmin")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Admin Course")
	result := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	// Admin is always an organizer for any existing round.
	isOrg, err := svc.IsRoundOrganizer(context.Background(), result.Round.ID, uuid.New(), "admin")
	require.NoError(t, err)
	assert.True(t, isOrg)
}

func TestRoundService_IsRoundOrganizer_RoundNotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))

	isOrg, err := svc.IsRoundOrganizer(context.Background(), uuid.New(), uuid.New(), "user")
	require.ErrorIs(t, err, services.ErrRoundNotFound)
	assert.False(t, isOrg)
}

func TestRoundService_IsRoundOrganizer_OrganizerReturnsTrue(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Augusta")
	result := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	isOrg, err := svc.IsRoundOrganizer(context.Background(), result.Round.ID, organizer.ID, "user")
	require.NoError(t, err)
	assert.True(t, isOrg)
}

func TestRoundService_IsRoundOrganizer_NonOrganizerReturnsFalse(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org2")
	member := seedUser(t, db, "member2")
	event := seedEvent(t, eventSvc, organizer.ID)
	addEventMember(t, db, event.ID, member.ID)
	course, tee := seedCourseWithTee(t, db, "Pebble Beach")
	result := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	isOrg, err := svc.IsRoundOrganizer(context.Background(), result.Round.ID, member.ID, "user")
	require.NoError(t, err)
	assert.False(t, isOrg)
}

// ─── Schedule ─────────────────────────────────────────────────────────────────

func TestRoundService_Schedule_ValidationErrors(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)
	eventID := uuid.New()
	callerID := uuid.New()

	cases := []struct {
		name    string
		in      services.ScheduleRoundInput
		wantMsg string
	}{
		{
			name:    "no course",
			in:      services.ScheduleRoundInput{ScheduledDate: "2025-06-01"},
			wantMsg: "course_id or course_name is required",
		},
		{
			name: "course_id without default_tee_id",
			in: services.ScheduleRoundInput{
				ScheduledDate: "2025-06-01",
				CourseID:      strPtr("some-id"),
			},
			wantMsg: "default_tee_id is required when course_id is provided",
		},
		{
			name: "missing scheduled_date",
			in: services.ScheduleRoundInput{
				CourseName: "Any Course",
			},
			wantMsg: "scheduled_date is required",
		},
		{
			name: "bad scheduled_date format",
			in: services.ScheduleRoundInput{
				CourseName:    "Any Course",
				ScheduledDate: "06/01/2025",
			},
			wantMsg: "scheduled_date must be YYYY-MM-DD",
		},
		{
			name: "bad nine_hole_selection",
			in: services.ScheduleRoundInput{
				CourseName:        "Any Course",
				ScheduledDate:     "2025-06-01",
				NineHoleSelection: strPtr("middle"),
			},
			wantMsg: `nine_hole_selection must be "front" or "back"`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.Schedule(context.Background(), eventID, callerID, "user", tc.in)
			var ve *services.ValidationError
			require.True(t, errors.As(err, &ve), "expected ValidationError, got %T: %v", err, err)
			assert.Equal(t, tc.wantMsg, ve.Message)
		})
	}
}

func TestRoundService_Schedule_ForbiddenForNonOrganizer(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org3")
	nonOrg := seedUser(t, db, "noorg3")
	event := seedEvent(t, eventSvc, organizer.ID)
	addEventMember(t, db, event.ID, nonOrg.ID)
	course, tee := seedCourseWithTee(t, db, "Torrey Pines")

	_, err := svc.Schedule(context.Background(), event.ID, nonOrg.ID, "user", services.ScheduleRoundInput{
		ScheduledDate: "2025-06-01",
		CourseID:      strPtr(course.ID.String()),
		DefaultTeeID:  strPtr(tee.ID.String()),
	})
	assert.ErrorIs(t, err, services.ErrRoundForbidden)
}

func TestRoundService_Schedule_SuccessWithCourseID(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org4")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Bethpage Black")

	result, err := svc.Schedule(context.Background(), event.ID, organizer.ID, "user", services.ScheduleRoundInput{
		Name:          "Round 1",
		ScheduledDate: "2025-07-04",
		CourseID:      strPtr(course.ID.String()),
		DefaultTeeID:  strPtr(tee.ID.String()),
	})
	require.NoError(t, err)
	assert.Equal(t, "Round 1", result.Round.Name)
	assert.Equal(t, "Bethpage Black", result.CourseName)
	assert.Equal(t, 1, result.Round.RoundNumber)
	assert.Equal(t, 1, result.GroupCount) // default one empty group
}

func TestRoundService_Schedule_SuccessWithCourseName_FindOrCreate(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org5")
	event := seedEvent(t, eventSvc, organizer.ID)

	// Course does not exist yet — service should create it.
	result, err := svc.Schedule(context.Background(), event.ID, organizer.ID, "user", services.ScheduleRoundInput{
		ScheduledDate: "2025-08-01",
		CourseName:    "Brand New Links",
	})
	require.NoError(t, err)
	assert.Equal(t, "Brand New Links", result.CourseName)

	// A second schedule with the same name should reuse the course.
	result2, err := svc.Schedule(context.Background(), event.ID, organizer.ID, "user", services.ScheduleRoundInput{
		ScheduledDate: "2025-08-08",
		CourseName:    "Brand New Links",
	})
	require.NoError(t, err)
	assert.Equal(t, result.Round.CourseID, result2.Round.CourseID, "should reuse existing course")
	assert.Equal(t, 2, result2.Round.RoundNumber)
}

func TestRoundService_Schedule_MultipleGroupsWithTeeTimes(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org6")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Shinnecock Hills")

	teeTime1 := "08:00"
	teeTime2 := "08:10"
	result, err := svc.Schedule(context.Background(), event.ID, organizer.ID, "user", services.ScheduleRoundInput{
		ScheduledDate: "2025-09-01",
		CourseID:      strPtr(course.ID.String()),
		DefaultTeeID:  strPtr(tee.ID.String()),
		Groups: []services.GroupScheduleInput{
			{TeeTime: &teeTime1},
			{TeeTime: &teeTime2},
		},
	})
	require.NoError(t, err)
	assert.Equal(t, 2, result.GroupCount)

	// Verify groups were actually created in the DB.
	var groupCount int64
	db.Model(&models.Group{}).Where("round_id = ?", result.Round.ID).Count(&groupCount)
	assert.Equal(t, int64(2), groupCount)
}

// ─── Get ──────────────────────────────────────────────────────────────────────

func TestRoundService_Get_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))

	_, err := svc.Get(context.Background(), uuid.New(), uuid.New(), "user")
	assert.ErrorIs(t, err, services.ErrRoundNotFound)
}

func TestRoundService_Get_ReturnsDetailWithIsOrganizer(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org7")
	member := seedUser(t, db, "mem7")
	event := seedEvent(t, eventSvc, organizer.ID)
	addEventMember(t, db, event.ID, member.ID)
	course, tee := seedCourseWithTee(t, db, "Oakmont")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	// Organizer should see is_organizer: true.
	result, err := svc.Get(context.Background(), scheduled.Round.ID, organizer.ID, "user")
	require.NoError(t, err)
	assert.True(t, result.IsOrganizer)
	assert.Equal(t, scheduled.Round.ID, result.Round.ID)

	// Member should see is_organizer: false.
	result2, err := svc.Get(context.Background(), scheduled.Round.ID, member.ID, "user")
	require.NoError(t, err)
	assert.False(t, result2.IsOrganizer)
}

// ─── Update ───────────────────────────────────────────────────────────────────

func TestRoundService_Update_ValidationErrors(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))
	roundID := uuid.New()
	callerID := uuid.New()

	cases := []struct {
		name    string
		in      services.UpdateRoundInput
		wantMsg string
	}{
		{
			name:    "empty name",
			in:      services.UpdateRoundInput{Name: strPtr("")},
			wantMsg: "name cannot be empty",
		},
		{
			name:    "empty scheduled_date",
			in:      services.UpdateRoundInput{ScheduledDate: strPtr("")},
			wantMsg: "scheduled_date cannot be empty",
		},
		{
			name:    "course_id without tee_id",
			in:      services.UpdateRoundInput{CourseID: strPtr("some-id")},
			wantMsg: "default_tee_id is required when course_id is provided",
		},
		{
			name:    "invalid status",
			in:      services.UpdateRoundInput{Status: strPtr("bogus")},
			wantMsg: "status must be 'scheduled', 'active', or 'completed'",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.Update(context.Background(), roundID, callerID, "user", tc.in)
			var ve *services.ValidationError
			require.True(t, errors.As(err, &ve), "expected ValidationError, got %T: %v", err, err)
			assert.Equal(t, tc.wantMsg, ve.Message)
		})
	}
}

func TestRoundService_Update_ForbiddenForNonOrganizer(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org8")
	nonOrg := seedUser(t, db, "noorg8")
	event := seedEvent(t, eventSvc, organizer.ID)
	addEventMember(t, db, event.ID, nonOrg.ID)
	course, tee := seedCourseWithTee(t, db, "Winged Foot")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	_, err := svc.Update(context.Background(), scheduled.Round.ID, nonOrg.ID, "user", services.UpdateRoundInput{
		Name: strPtr("Renamed"),
	})
	assert.ErrorIs(t, err, services.ErrRoundForbidden)
}

func TestRoundService_Update_Success(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org9")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Riviera")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	result, err := svc.Update(context.Background(), scheduled.Round.ID, organizer.ID, "user", services.UpdateRoundInput{
		Name:   strPtr("Championship Round"),
		Status: strPtr("active"),
	})
	require.NoError(t, err)
	assert.Equal(t, "Championship Round", result.Round.Name)
	assert.Equal(t, models.RoundStatusActive, result.Round.Status)
}

// ─── Delete ───────────────────────────────────────────────────────────────────

func TestRoundService_Delete_NotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))

	err := svc.Delete(context.Background(), uuid.New(), uuid.New(), "admin")
	assert.ErrorIs(t, err, services.ErrRoundNotFound)
}

func TestRoundService_Delete_ForbiddenForNonOrganizer(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org10")
	nonOrg := seedUser(t, db, "noorg10")
	event := seedEvent(t, eventSvc, organizer.ID)
	addEventMember(t, db, event.ID, nonOrg.ID)
	course, tee := seedCourseWithTee(t, db, "Congressional")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	err := svc.Delete(context.Background(), scheduled.Round.ID, nonOrg.ID, "user")
	assert.ErrorIs(t, err, services.ErrRoundForbidden)
}

func TestRoundService_Delete_Success(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org11")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Medinah")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	require.NoError(t, svc.Delete(context.Background(), scheduled.Round.ID, organizer.ID, "user"))

	// Round should be gone.
	err := svc.Delete(context.Background(), scheduled.Round.ID, organizer.ID, "user")
	assert.ErrorIs(t, err, services.ErrRoundNotFound)
}

// ─── CreateGroup ──────────────────────────────────────────────────────────────

func TestRoundService_CreateGroup_ForbiddenForNonOrganizer(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org12")
	nonOrg := seedUser(t, db, "noorg12")
	event := seedEvent(t, eventSvc, organizer.ID)
	addEventMember(t, db, event.ID, nonOrg.ID)
	course, tee := seedCourseWithTee(t, db, "TPC Sawgrass")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	_, err := svc.CreateGroup(context.Background(), scheduled.Round.ID, nonOrg.ID, "user")
	assert.ErrorIs(t, err, services.ErrRoundForbidden)
}

func TestRoundService_CreateGroup_AutoNumbers(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org13")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "East Lake")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())
	// scheduleRound created group 1 already; creating another should be group 2.

	result, err := svc.CreateGroup(context.Background(), scheduled.Round.ID, organizer.ID, "user")
	require.NoError(t, err)
	assert.Equal(t, 2, result.Group.GroupNumber)
}

// ─── AddGroupMember / RemoveGroupMember ───────────────────────────────────────

func TestRoundService_AddGroupMember_GroupFullReturnsError(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org14")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Muirfield Village")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	// The schedule created one group — get its ID.
	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	// Add 4 members to fill the group.
	for i := 0; i < 4; i++ {
		u := seedUser(t, db, "filler14"+string(rune('a'+i)))
		addEventMember(t, db, event.ID, u.ID)
		_, err := svc.AddGroupMember(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, u.ID, "user")
		require.NoError(t, err, "adding player %d should succeed", i+1)
	}

	// A 5th add should return ErrGroupFull.
	extra := seedUser(t, db, "extra14")
	addEventMember(t, db, event.ID, extra.ID)
	_, err := svc.AddGroupMember(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, extra.ID, "user")
	assert.ErrorIs(t, err, services.ErrGroupFull)
}

func TestRoundService_AddGroupMember_AlreadyInGroupReturnsError(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org15")
	player := seedUser(t, db, "player15")
	event := seedEvent(t, eventSvc, organizer.ID)
	addEventMember(t, db, event.ID, player.ID)
	course, tee := seedCourseWithTee(t, db, "Southern Hills")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	_, err := svc.AddGroupMember(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, player.ID, "user")
	require.NoError(t, err)

	// Second add should return ErrPlayerAlreadyInGroup.
	_, err = svc.AddGroupMember(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, player.ID, "user")
	assert.ErrorIs(t, err, services.ErrPlayerAlreadyInGroup)
}

func TestRoundService_RemoveGroupMember_NotInRoundReturnsError(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org16")
	stranger := seedUser(t, db, "stranger16")
	event := seedEvent(t, eventSvc, organizer.ID)
	addEventMember(t, db, event.ID, stranger.ID)
	course, tee := seedCourseWithTee(t, db, "Hazeltine")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	err := svc.RemoveGroupMember(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, stranger.ID, "user")
	assert.ErrorIs(t, err, services.ErrPlayerNotInRound)
}

func TestRoundService_AddRemoveGroupMember_HappyPath(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org17")
	player := seedUser(t, db, "player17")
	event := seedEvent(t, eventSvc, organizer.ID)
	addEventMember(t, db, event.ID, player.ID)
	course, tee := seedCourseWithTee(t, db, "Quail Hollow")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	// Add player.
	result, err := svc.AddGroupMember(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, player.ID, "user")
	require.NoError(t, err)
	assert.Len(t, result.Players, 1)
	assert.Equal(t, player.ID.String(), result.Players[0].UserID)

	// Remove player.
	err = svc.RemoveGroupMember(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, player.ID, "user")
	require.NoError(t, err)

	// Group should be empty.
	result2, err := svc.Get(context.Background(), scheduled.Round.ID, organizer.ID, "user")
	require.NoError(t, err)
	assert.Empty(t, result2.Groups[0].Players)
}

// ─── UpdateGroup ──────────────────────────────────────────────────────────────

func TestRoundService_UpdateGroup_InvalidTeeTimeFormat(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))

	_, err := svc.UpdateGroup(context.Background(), uuid.New(), uuid.New(), uuid.New(), "user", services.UpdateGroupInput{
		TeeTime: strPtr("25:99"),
	})
	var ve *services.ValidationError
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, "tee_time must be HH:MM or H:MM AM/PM", ve.Message)
}

func TestRoundService_UpdateGroup_Success(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org18")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Firestone")
	scheduled := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	var group models.Group
	require.NoError(t, db.Where("round_id = ?", scheduled.Round.ID).First(&group).Error)

	name := "Morning Wave"
	teeTimeStr := "08:30"
	result, err := svc.UpdateGroup(context.Background(), scheduled.Round.ID, group.ID, organizer.ID, "user", services.UpdateGroupInput{
		Name:    &name,
		TeeTime: &teeTimeStr,
	})
	require.NoError(t, err)
	require.NotNil(t, result.Group.Name)
	assert.Equal(t, "Morning Wave", *result.Group.Name)
	require.NotNil(t, result.Group.TeeTime)
	assert.Equal(t, 8, result.Group.TeeTime.Hour())
	assert.Equal(t, 30, result.Group.TeeTime.Minute())
}

// ─── GetMyRounds ──────────────────────────────────────────────────────────────

func TestRoundService_GetMyRounds_NoMemberships(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))

	user := seedUser(t, db, "loner19")
	results, err := svc.GetMyRounds(context.Background(), user.ID)
	require.NoError(t, err)
	assert.Empty(t, results)
}

func TestRoundService_GetMyRounds_ReturnsOwnRounds(t *testing.T) {
	db := testutil.NewTestDB(t)
	eventSvc := services.NewEventService(db)
	svc := services.NewRoundService(db, eventSvc)

	organizer := seedUser(t, db, "org20")
	event := seedEvent(t, eventSvc, organizer.ID)
	course, tee := seedCourseWithTee(t, db, "Olympic Club")
	r1 := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())
	r2 := scheduleRound(t, svc, event.ID, organizer.ID, course.ID.String(), tee.ID.String())

	// GetMyRounds uses round_players.user_id — a user only sees rounds they are
	// actually playing in. Add the organizer as a round player to each round directly.
	// (Schedule creates groups but does not auto-add the organizer as a player.)
	// seedEvent auto-creates the organizer event_player; look it up rather than re-inserting.
	var orgEP models.EventPlayer
	require.NoError(t, db.Where("event_id = ? AND user_id = ?", event.ID, organizer.ID).First(&orgEP).Error)
	rp1 := addRoundPlayer(t, db, r1.Round.ID, orgEP.ID)
	rp2 := addRoundPlayer(t, db, r2.Round.ID, orgEP.ID)
	require.NotEmpty(t, rp1.ID)
	require.NotEmpty(t, rp2.ID)

	results, err := svc.GetMyRounds(context.Background(), organizer.ID)
	require.NoError(t, err)
	assert.Len(t, results, 2)
}

// ─── CreateEventlessRound ─────────────────────────────────────────────────────

func TestRoundService_CreateEventlessRound_WithCourseName(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))
	creator := seedUser(t, db, "elCreator1")

	result, err := svc.CreateEventlessRound(context.Background(), creator.ID, services.CreateEventlessRoundInput{
		CourseName:    "Winged Foot",
		ScheduledDate: "2025-08-01",
	})
	require.NoError(t, err)
	assert.Equal(t, "Round", result.Round.Name)
	assert.Equal(t, "Winged Foot", result.CourseName)
	assert.Nil(t, result.Round.EventID)
	require.NotNil(t, result.Round.CreatedBy)
	assert.Equal(t, creator.ID, *result.Round.CreatedBy)

	// Creator must be in Group 1 as a round_player.
	var rp models.RoundPlayer
	require.NoError(t, db.Where("round_id = ? AND user_id = ?", result.Round.ID, creator.ID).First(&rp).Error)
	var gp models.GroupPlayer
	require.NoError(t, db.Where("round_player_id = ?", rp.ID).First(&gp).Error)
	var group models.Group
	require.NoError(t, db.First(&group, "id = ?", gp.GroupID).Error)
	assert.Equal(t, 1, group.GroupNumber)
}

func TestRoundService_CreateEventlessRound_WithExistingCourseName(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))
	creator := seedUser(t, db, "elCreator2")

	// Pre-seed the course so the ILIKE match path is taken.
	existingCourse, _ := seedCourseWithTee(t, db, "Shinnecock Hills")

	result, err := svc.CreateEventlessRound(context.Background(), creator.ID, services.CreateEventlessRoundInput{
		CourseName:    "Shinnecock Hills",
		ScheduledDate: "2025-08-01",
	})
	require.NoError(t, err)
	assert.Equal(t, existingCourse.ID, result.Round.CourseID)
	assert.Nil(t, result.Round.EventID)
}

func TestRoundService_CreateEventlessRound_WithCourseID(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))
	creator := seedUser(t, db, "elCreator3")
	course, tee := seedCourseWithTee(t, db, "Merion")

	courseIDStr := course.ID.String()
	teeIDStr := tee.ID.String()
	result, err := svc.CreateEventlessRound(context.Background(), creator.ID, services.CreateEventlessRoundInput{
		CourseID:      &courseIDStr,
		DefaultTeeID:  &teeIDStr,
		ScheduledDate: "2025-08-01",
		Name:          "Solo Round",
	})
	require.NoError(t, err)
	assert.Equal(t, "Solo Round", result.Round.Name)
	assert.Equal(t, course.ID, result.Round.CourseID)
	assert.Equal(t, tee.ID, result.Round.DefaultTeeID)
	assert.Nil(t, result.Round.EventID)
}

func TestRoundService_CreateEventlessRound_CourseNotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))
	creator := seedUser(t, db, "elCreator4")

	unknownID := uuid.New().String()
	teeID := uuid.New().String()
	_, err := svc.CreateEventlessRound(context.Background(), creator.ID, services.CreateEventlessRoundInput{
		CourseID:      &unknownID,
		DefaultTeeID:  &teeID,
		ScheduledDate: "2025-08-01",
	})
	require.ErrorIs(t, err, services.ErrCourseNotFound)
}

func TestRoundService_CreateEventlessRound_TeeNotFound(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))
	creator := seedUser(t, db, "elCreator5")
	course, _ := seedCourseWithTee(t, db, "Baltusrol")

	courseIDStr := course.ID.String()
	wrongTeeID := uuid.New().String()
	_, err := svc.CreateEventlessRound(context.Background(), creator.ID, services.CreateEventlessRoundInput{
		CourseID:      &courseIDStr,
		DefaultTeeID:  &wrongTeeID,
		ScheduledDate: "2025-08-01",
	})
	require.ErrorIs(t, err, services.ErrTeeNotFound)
}

// TestRoundService_IsRoundOrganizer_EventlessCreatorIsOrganizer verifies that
// the creator of an eventless round is its organizer.
func TestRoundService_IsRoundOrganizer_EventlessCreatorIsOrganizer(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))
	creator := seedUser(t, db, "elOrg1")

	result, err := svc.CreateEventlessRound(context.Background(), creator.ID, services.CreateEventlessRoundInput{
		CourseName:    "Oakland Hills",
		ScheduledDate: "2025-08-01",
	})
	require.NoError(t, err)

	isOrg, err := svc.IsRoundOrganizer(context.Background(), result.Round.ID, creator.ID, "user")
	require.NoError(t, err)
	assert.True(t, isOrg)
}

// TestRoundService_IsRoundOrganizer_EventlessNonCreatorNotOrganizer verifies
// that a user who is not the creator of an eventless round is not an organizer.
func TestRoundService_IsRoundOrganizer_EventlessNonCreatorNotOrganizer(t *testing.T) {
	db := testutil.NewTestDB(t)
	svc := services.NewRoundService(db, services.NewEventService(db))
	creator := seedUser(t, db, "elOrg2")
	other := seedUser(t, db, "elOther2")

	result, err := svc.CreateEventlessRound(context.Background(), creator.ID, services.CreateEventlessRoundInput{
		CourseName:    "Oakmont",
		ScheduledDate: "2025-08-01",
	})
	require.NoError(t, err)

	isOrg, err := svc.IsRoundOrganizer(context.Background(), result.Round.ID, other.ID, "user")
	require.NoError(t, err)
	assert.False(t, isOrg)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func strPtr(s string) *string { return &s }
