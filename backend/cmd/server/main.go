// cmd/server/main.go
// Entry point for the Golf League API server.
// The cmd/server layout follows the Go convention: cmd/ holds executables,
// internal/ holds reusable packages not importable by other projects.
package main

import (
	"fmt"
	"log"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	sentryfiber "github.com/getsentry/sentry-go/fiber"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	fiberrecover "github.com/gofiber/fiber/v2/middleware/recover"

	"github.com/trentd187/golf-league/internal/config"
	"github.com/trentd187/golf-league/internal/database"
	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/middleware"
	"github.com/trentd187/golf-league/internal/observability"
	"github.com/trentd187/golf-league/internal/services"
	"github.com/trentd187/golf-league/internal/websocket"
)

func main() {
	cfg := config.Load()

	// Initialise Sentry (single observability vendor: errors, traces, profiles, logs).
	// When SENTRY_DSN is empty (local dev without an account), logger is stdout-only
	// and shutdown is a no-op — server runs identically without telemetry.
	logger, sentryShutdown, err := observability.Init(cfg)
	if err != nil {
		log.Fatal("Failed to initialise Sentry:", err)
	}
	defer sentryShutdown()
	slog.SetDefault(logger)

	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}

	if err := database.RunMigrations(cfg.DatabaseURL); err != nil {
		log.Fatal("Failed to run migrations:", err)
	}
	fmt.Println("Migrations applied successfully")

	// NewHub + supervised run starts the WebSocket broadcast loop as a background
	// goroutine (so it doesn't block startup). RunHubSupervised recovers + restarts
	// on panic so one bad broadcast can't permanently kill live updates.
	hub := websocket.NewHub()
	go websocket.RunHubSupervised(hub)

	// GolfCourseAPIClient is created once and shared across requests.
	// GOLF_COURSE_API_KEY may be empty — the service returns ErrExternalAPINotConfigured
	// (mapped to 503) if any external-API method is called without a key.
	golfAPI := services.NewGolfCourseAPIClient(cfg.GolfCourseAPIKey)

	// CourseService bundles the DB and external-API client behind one dependency
	// for every course/tee/hole handler.
	courseService := services.NewCourseService(db, golfAPI)

	// EventService owns event/member/event-round-list business logic.
	// IsOrganizer is exposed for cross-service use by RoundService and ScoreService.
	eventService := services.NewEventService(db)

	// RoundService owns round scheduling, group management, and member assignment.
	// Depends on EventService for the shared IsOrganizer permission check.
	roundService := services.NewRoundService(db, eventService)

	// ScoreService owns scorecard assembly, score entry, handicap, and hole stats.
	// Depends on EventService for the organizer-bypass permission path in canModifyScores.
	scoreService := services.NewScoreService(db, eventService)

	// UserService owns profile lookup, follow/unfollow, career stats, and scorecard settings.
	userService := services.NewUserService(db)

	app := fiber.New(fiber.Config{
		AppName: "Golf League API",
	})

	// fiberrecover catches any panics in middleware or handlers and returns 500 instead
	// of crashing the server process. Must be registered first so it wraps everything.
	app.Use(fiberrecover.New())

	app.Use(cors.New())

	// sentryfiber installs a per-request Sentry Hub on c.Context() so handlers can
	// call sentryfiber.GetHubFromContext(c) and capture exceptions, set tags, or
	// attach the authenticated user without sharing scope across requests.
	// Repanic:true defers HTTP response writing to fiberrecover, which is already
	// registered above. WaitForDelivery is false because requests must not block
	// on Sentry's network; sentry.Flush(2s) at shutdown drains the buffer instead.
	app.Use(sentryfiber.New(sentryfiber.Options{
		Repanic:         true,
		WaitForDelivery: false,
		Timeout:         5 * time.Second,
	}))

	// ErrorLogger emits a slog.Error (→ Sentry Issue + searchable log) for every 5xx,
	// reading the root cause each handler records in c.Locals("error_detail"). Must
	// follow sentryfiber so the per-request hub is on c.UserContext().
	app.Use(middleware.ErrorLogger())

	// GET /health — liveness check for Railway and load balancers; no auth, no DB.
	app.Get("/health", handlers.HealthCheck)

	// All routes under /api/v1 require a valid Supabase JWT.
	// app.Group applies the middleware to every route registered on the returned group.
	api := app.Group("/api/v1", middleware.Auth(cfg, db))

	// durableIdempotency makes the non-idempotent POST creates it wraps safe to retry on
	// a flaky cellular link: a repeat bearing the same Idempotency-Key replays the
	// original response (durable store, migration 000024) instead of inserting a second
	// row. Applied to every create route below (event, eventless/scheduled round, groups,
	// members, guests, teams). The idempotent PATCH/PUT mutations keep the lighter
	// in-memory replayLog, which only turns a retry-on-an-already-committed save into a
	// phantom-save signal (no second row is possible). Both are constructed here so they're
	// in scope for the round routes that follow.
	durableIdempotency := middleware.Idempotency(middleware.NewDurableIdempotencyStore(db))
	idempotencyStore := middleware.NewIdempotencyStore()
	replayLog := middleware.IdempotencyReplayLog(idempotencyStore)

	// Event routes — any authenticated user can create events (they become the organizer).
	// /events/public must be registered before /events/:id so Fiber matches it literally.
	api.Get("/events", handlers.GetEvents(eventService))
	api.Get("/events/public", handlers.GetPublicEvents(eventService))
	api.Post("/events", durableIdempotency, handlers.CreateEvent(eventService))

	api.Get("/events/:id", handlers.GetEvent(eventService))
	api.Patch("/events/:id", handlers.UpdateEvent(eventService))
	api.Delete("/events/:id", handlers.DeleteEvent(eventService))

	api.Get("/events/:id/members", handlers.GetEventMembers(eventService))
	api.Post("/events/:id/members", durableIdempotency, handlers.AddEventMember(eventService))
	api.Delete("/events/:id/members/:userId", handlers.RemoveEventMember(eventService))
	api.Patch("/events/:id/members/:userId/role", handlers.UpdateMemberRole(eventService))

	api.Get("/events/:id/rounds", handlers.GetEventRounds(eventService))
	api.Post("/events/:id/rounds", durableIdempotency, handlers.ScheduleEventRound(roundService))

	api.Post("/events/:id/request-join", handlers.RequestJoinEvent(eventService))
	api.Get("/events/:id/join-requests", handlers.GetJoinRequests(eventService))
	api.Patch("/events/:id/join-requests/:userId", handlers.HandleJoinRequest(eventService))

	// Round routes — round IDs are globally unique, so these are top-level.
	// GET and POST /rounds must be registered before /rounds/:roundId so Fiber's
	// router doesn't treat "rounds" as a roundId parameter.
	api.Post("/rounds", durableIdempotency, handlers.CreateEventlessRound(roundService))
	api.Get("/rounds", handlers.GetMyRounds(roundService))
	api.Get("/rounds/:roundId", handlers.GetRound(roundService))
	api.Patch("/rounds/:roundId", replayLog, handlers.UpdateRound(roundService))
	api.Delete("/rounds/:roundId", handlers.DeleteRound(roundService))
	api.Post("/rounds/:roundId/groups", durableIdempotency, handlers.CreateGroup(roundService))
	api.Patch("/rounds/:roundId/groups/:groupId", handlers.UpdateGroup(roundService))
	api.Delete("/rounds/:roundId/groups/:groupId", handlers.DeleteGroup(roundService))
	api.Post("/rounds/:roundId/groups/:groupId/members", durableIdempotency, handlers.AddGroupMember(roundService))
	api.Post("/rounds/:roundId/groups/:groupId/guests", durableIdempotency, handlers.AddGuestToGroup(roundService))
	api.Delete("/rounds/:roundId/groups/:groupId/members/:userId", handlers.RemoveGroupMember(roundService))

	// Las Vegas team routes — organizer-only partner assignment for las_vegas rounds.
	api.Get("/rounds/:roundId/teams", handlers.ListTeams(roundService))
	api.Post("/rounds/:roundId/teams", durableIdempotency, handlers.CreateTeam(roundService))
	api.Put("/rounds/:roundId/teams/:teamId/members", replayLog, handlers.AssignTeamMembers(roundService))
	api.Delete("/rounds/:roundId/teams/:teamId", handlers.DeleteTeam(roundService))

	// Score routes — permission enforced inside ScoreService.canModifyScores.
	// replayLog (constructed above) turns a client retry that lands on an already-committed
	// (idempotent) save into a server-side phantom-save signal.
	api.Get("/rounds/:roundId/scorecard", handlers.GetRoundScorecard(scoreService))
	api.Put("/rounds/:roundId/players/:roundPlayerId/handicap", handlers.SetPlayerHandicap(scoreService))
	api.Put("/rounds/:roundId/players/:roundPlayerId/scores", replayLog, handlers.UpsertPlayerScores(scoreService, hub))
	api.Put("/rounds/:roundId/players/:roundPlayerId/hole-stats", replayLog, handlers.UpsertHoleStats(scoreService, hub))

	// Live-score WebSocket. Registered on `app` (not the `api` group) because it uses
	// query-param auth — a browser can't set an Authorization header on a WS upgrade.
	// middleware.WSAuth validates ?token= and rejects non-upgrade requests with 426.
	app.Get("/api/v1/ws/rounds/:roundId", middleware.WSAuth(cfg), websocket.ServeRoundWS(hub))

	// Course routes — GET open to any authenticated user; mutations restricted to admin only
	api.Get("/courses", handlers.GetCourses(courseService))
	api.Post("/courses", middleware.RequireRole("admin"), handlers.CreateCourse(courseService))
	api.Get("/courses/:courseId", handlers.GetCourse(courseService))
	api.Patch("/courses/:courseId", middleware.RequireRole("admin"), handlers.UpdateCourse(courseService))

	api.Post("/courses/:courseId/tees", middleware.RequireRole("admin"), handlers.CreateTee(courseService))
	api.Patch("/courses/:courseId/tees/:teeId", middleware.RequireRole("admin"), handlers.UpdateTee(courseService))
	api.Delete("/courses/:courseId/tees/:teeId", middleware.RequireRole("admin"), handlers.DeleteTee(courseService))

	api.Put("/courses/:courseId/tees/:teeId/holes", middleware.RequireRole("admin"), handlers.UpsertHoles(courseService))
	api.Patch("/courses/:courseId/tees/:teeId/holes/:holeNumber", middleware.RequireRole("admin"), handlers.UpdateHole(courseService))

	// External course import — search returns results without writing; import/refresh write to DB
	api.Post("/courses/search-external", middleware.RequireRole("admin"), handlers.SearchExternalCourse(courseService))
	api.Post("/courses/import-external", middleware.RequireRole("admin"), handlers.ImportExternalCourse(courseService))
	api.Post("/courses/:courseId/refresh", middleware.RequireRole("admin"), handlers.RefreshCourse(courseService))

	// User routes — static paths must be registered before parameterised ones so Fiber
	// doesn't treat "following" or "me" as a userId value.
	api.Get("/me", handlers.GetMe(userService))
	api.Get("/users/following", handlers.GetFollowing(userService))
	api.Get("/users/me/scorecard-settings", handlers.GetScorecardSettings(userService))
	api.Patch("/users/me/scorecard-settings", handlers.UpsertScorecardSettings(userService))
	api.Get("/users/:userId", handlers.GetUserProfile(userService))
	api.Get("/users/:userId/stats", handlers.GetUserStats(userService))
	api.Get("/users/:userId/rounds", handlers.GetUserRounds(userService))
	// Batched scorecards for a user's last-N completed rounds in one response — the stats
	// screen feeds these to the client-side stat math instead of fanning out one
	// /rounds/:id/scorecard per round (removes the FRONTEND-2 N+1).
	api.Get("/users/:userId/scorecards", handlers.GetUserScorecards(scoreService))
	api.Post("/users/:userId/follow", handlers.FollowUser(userService))
	api.Delete("/users/:userId/follow", handlers.UnfollowUser(userService))
	api.Get("/users", handlers.SearchUsers(userService))

	// Start the server in a goroutine so we can listen for OS signals below.
	// SIGTERM is sent by Railway (and Docker) when the container is being stopped;
	// the deferred sentryShutdown flushes buffered events before the process exits.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		slog.Info("Server starting",
			"event_type_label", "server.startup",
			"port", cfg.Port,
			"env", cfg.Env)
		if err := app.Listen(":" + cfg.Port); err != nil {
			log.Printf("Server listen error: %v", err)
		}
	}()

	<-quit

	slog.Info("Server shutting down", "event_type_label", "server.shutdown")
	if err := app.Shutdown(); err != nil {
		log.Printf("Server shutdown error: %v", err)
	}
}
