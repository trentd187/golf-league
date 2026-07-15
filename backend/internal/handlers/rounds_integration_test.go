// rounds_integration_test.go
// Tier 2 (real-database) tests for the round handlers.
//
// The Tier 1 tests in rounds_test.go / rounds_eventless_test.go pass a nil DB and only reach
// validation branches that return before any DB call. These spin up an ephemeral Postgres via
// testutil.NewTestDB and exercise the full handler -> RoundService -> DB path.
//
// The success path of CreateEventlessRound matters more than it looks: it is the "Create
// Round" button — the most-used create in the app — and until this change it emitted NO
// business event at all (ScheduleEventRound has always emitted round.created; the casual-round
// path was simply never given one). So the single most common create in the product was
// invisible in Sentry.
//
// Docker must be running (testcontainers). Do NOT call t.Parallel().
package handlers_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/models"
	"github.com/trentd187/golf-league/internal/services"
	"github.com/trentd187/golf-league/internal/testutil"
)

// newAppAsUser builds a single-route app whose auth middleware reports the given caller.
func newAppAsUser(method, path string, userID uuid.UUID, handler fiber.Handler) *fiber.App {
	app := fiber.New(fiber.Config{DisableStartupMessage: true})
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("userID", userID.String())
		c.Locals("userRole", "user")
		return c.Next()
	})
	app.Add(method, path, handler)
	return app
}

// seedRoundUser inserts a plain user to act as the round's creator.
func seedRoundUser(t *testing.T, db *gorm.DB) models.User {
	t.Helper()
	u := models.User{
		DisplayName: "Round Creator",
		Email:       "creator-" + uuid.NewString() + "@example.com",
		Role:        models.UserRoleUser,
	}
	require.NoError(t, db.Create(&u).Error)
	return u
}

func TestCreateEventlessRound_Success_CreatesTheRound(t *testing.T) {
	db := testutil.NewTestDB(t)
	user := seedRoundUser(t, db)
	course := seedCourse(t, db, "Casual Round Course")
	tee := seedTee(t, db, course.ID, "Blue")

	svc := services.NewRoundService(db, services.NewEventService(db))
	app := newAppAsUser(http.MethodPost, "/rounds", user.ID, handlers.CreateEventlessRound(svc))

	courseID, teeID := course.ID.String(), tee.ID.String()
	resp := doJSON(t, app, http.MethodPost, "/rounds", map[string]any{
		"name":           "Saturday Casual",
		"scheduled_date": time.Now().UTC().Format("2006-01-02"),
		"course_id":      courseID,
		"default_tee_id": teeID,
	})

	require.Equal(t, http.StatusCreated, resp.StatusCode)

	// The round really exists, and it is eventless (event_id NULL) — the defining property of
	// a casual round.
	var round models.Round
	require.NoError(t, db.First(&round, "created_by = ?", user.ID).Error)
	assert.Equal(t, "Saturday Casual", round.Name)
	assert.Nil(t, round.EventID)
}

// ─── Scorecard read handlers (Tier 2) ─────────────────────────────────────────
//
// Both were only covered on their bad-UUID branch. GetEventScorecards in particular is the
// endpoint that replaced the event screen's useQueries() fan-out, so its happy path is worth
// exercising against a real database.

func TestGetRoundScorecard_Success(t *testing.T) {
	db := testutil.NewTestDB(t)
	user := seedRoundUser(t, db)
	course := seedCourse(t, db, "Scorecard Read Course")
	tee := seedTee(t, db, course.ID, "White")

	roundSvc := services.NewRoundService(db, services.NewEventService(db))
	courseID, teeID := course.ID.String(), tee.ID.String()
	created, err := roundSvc.CreateEventlessRound(context.Background(), user.ID,
		services.CreateEventlessRoundInput{
			Name:          "Read Me",
			ScheduledDate: time.Now().UTC().Format("2006-01-02"),
			CourseID:      &courseID,
			DefaultTeeID:  &teeID,
		})
	require.NoError(t, err)

	scoreSvc := services.NewScoreService(db, services.NewEventService(db))
	app := newAppAsUser(http.MethodGet, "/rounds/:roundId/scorecard", user.ID,
		handlers.GetRoundScorecard(scoreSvc))

	resp := testutil.DoRequest(t, app, http.MethodGet,
		"/rounds/"+created.Round.ID.String()+"/scorecard", nil)

	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestGetEventScorecards_Success_EmptyWhenNoCompletedRounds(t *testing.T) {
	db := testutil.NewTestDB(t)
	user := seedRoundUser(t, db)

	eventSvc := services.NewEventService(db)
	event, err := eventSvc.Create(context.Background(), services.CreateEventInput{
		Name:      "Scorecards Event",
		EventType: "league",
		CreatedBy: user.ID,
	})
	require.NoError(t, err)

	scoreSvc := services.NewScoreService(db, eventSvc)
	app := newAppAsUser(http.MethodGet, "/events/:id/scorecards", user.ID,
		handlers.GetEventScorecards(scoreSvc))

	resp := testutil.DoRequest(t, app, http.MethodGet,
		"/events/"+event.Event.ID.String()+"/scorecards", nil)

	// No completed rounds yet — an empty list, not an error.
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}
