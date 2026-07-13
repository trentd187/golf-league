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
	fiberrecover "github.com/gofiber/fiber/v2/middleware/recover"

	"github.com/trentd187/golf-league/internal/config"
	"github.com/trentd187/golf-league/internal/database"
	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/middleware"
	"github.com/trentd187/golf-league/internal/observability"
	"github.com/trentd187/golf-league/internal/services"
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

	db, err := database.Connect(cfg.DatabaseURL, database.PoolConfig{
		MaxOpenConns:    cfg.DBMaxOpenConns,
		MaxIdleConns:    cfg.DBMaxIdleConns,
		ConnMaxLifetime: cfg.DBConnMaxLifetime,
		ConnMaxIdleTime: cfg.DBConnMaxIdleTime,
	})
	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}
	// sqlDB is the pooled *sql.DB behind GORM — used by the /health readiness ping.
	sqlDB, err := db.DB()
	if err != nil {
		log.Fatal("Failed to access database handle:", err)
	}

	if err := database.RunMigrations(cfg.DatabaseURL); err != nil {
		log.Fatal("Failed to run migrations:", err)
	}
	fmt.Println("Migrations applied successfully")

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
		// IdleTimeout closes idle keep-alive connections so a churn of half-open sockets
		// (the cellular case) doesn't accumulate.
		IdleTimeout: 60 * time.Second,
		// ReadTimeout/WriteTimeout bound a client that dribbles a request or stops reading
		// its response — a real risk on the flaky cellular links this app runs on. They were
		// deliberately unset while the live-score WebSocket existed, because WriteTimeout
		// kills a long-lived connection; with the socket gone, every request is short and
		// these are safe. They complement (not replace) the per-request context deadline in
		// middleware.RequestTimeout, which is what turns a hung DB query into a logged 5xx.
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	})

	// fiberrecover catches any panics in middleware or handlers and returns 500 instead
	// of crashing the server process. Must be registered first so it wraps everything.
	app.Use(fiberrecover.New())

	// Explicit CORS allow-list (incl. Idempotency-Key + Sentry tracing headers) so the web
	// build's preflight can't silently strip them. See middleware/cors.go.
	app.Use(middleware.CORS())

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

	// RequestLogger emits a per-request access line (method, path, status, latency, caller)
	// to stdout (Railway deploy logs) and Sentry Logs, escalating 4xx/5xx and slow requests
	// to Warn. It closes the "empty http log stream" gap that left the 7/3 502 window
	// undiagnosable. 2s is the slow threshold — above the 99th percentile of normal handlers.
	app.Use(middleware.RequestLogger(2 * time.Second))

	// GET /health — readiness probe for Railway and load balancers: no auth, but it pings the
	// DB so a wedged connection pool surfaces as a 503 instead of a false 200 (the 7/3 mode).
	app.Get("/health", handlers.HealthCheck(sqlDB))

	// All routes under /api/v1 require a valid Supabase JWT. RequestTimeout runs first so
	// every handler's context carries a deadline — a hung DB query fails fast into a logged
	// 5xx instead of a silent 502.
	// app.Group applies the middleware to every route registered on the returned group.
	api := app.Group("/api/v1", middleware.RequestTimeout(cfg.RequestTimeout), middleware.Auth(cfg, db))

	// durableIdempotency makes the non-idempotent POST creates it wraps safe to retry on
	// a flaky cellular link: a repeat bearing the same Idempotency-Key replays the
	// original response (durable store, migration 000024) instead of inserting a second
	// row. Applied to every create route below (event, eventless/scheduled round, groups,
	// members, guests, teams). The idempotent PATCH/PUT mutations keep the lighter
	// in-memory replayLog, which only turns a retry-on-an-already-committed save into a
	// phantom-save signal (no second row is possible). Both are constructed here so they're
	// in scope for the round routes that follow.
	durableStore := middleware.NewDurableIdempotencyStore(db)
	durableIdempotency := middleware.Idempotency(durableStore)
	idempotencyStore := middleware.NewIdempotencyStore()
	replayLog := middleware.IdempotencyReplayLog(idempotencyStore)

	// Create-side phantom recovery: when a POST create commits but every ack is lost on
	// cellular, the client exhausts its retry budget and can't learn the new row's id.
	// This lets it recover deterministically by replaying the stored response for the SAME
	// Idempotency-Key it already holds — works for every create type. See savePost.ts.
	api.Get("/idempotency/:key", handlers.LookupIdempotentResponse(durableStore))

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

	// request-join is a non-idempotent create (RequestJoin returns ErrMemberAlreadyExists on a
	// duplicate), so it needs durableIdempotency for the client's savePost retry to replay the
	// original 2xx instead of surfacing "already a member" after a cellular phantom.
	api.Post("/events/:id/request-join", durableIdempotency, handlers.RequestJoinEvent(eventService))
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
	api.Put("/rounds/:roundId/players/:roundPlayerId/scores", replayLog, handlers.UpsertPlayerScores(scoreService))
	api.Put("/rounds/:roundId/players/:roundPlayerId/hole-stats", replayLog, handlers.UpsertHoleStats(scoreService))

	// Retired live-score WebSocket, kept only as a tombstone. Builds already on players'
	// phones still dial it; a definitive 410 lets their reconnect loop give up once and
	// settle on the 60s poll instead of storming. No auth — the point is a cheap, certain
	// rejection. Registered on `app` (not `api`) to match the old path exactly. Delete this
	// route and handlers.WSSunset once ws.sunset_hit goes quiet. See handlers/sunset.go.
	app.Get("/api/v1/ws/rounds/:roundId", handlers.WSSunset())

	// Course routes — GET open to any authenticated user; mutations restricted to admin only
	api.Get("/courses", handlers.GetCourses(courseService))
	// Course create is a non-idempotent insert; durableIdempotency (after the admin gate)
	// lets savePost retry a cellular phantom without creating a duplicate course.
	api.Post("/courses", middleware.RequireRole("admin"), durableIdempotency, handlers.CreateCourse(courseService))
	api.Get("/courses/:courseId", handlers.GetCourse(courseService))
	api.Patch("/courses/:courseId", middleware.RequireRole("admin"), handlers.UpdateCourse(courseService))
	api.Delete("/courses/:courseId", middleware.RequireRole("admin"), handlers.DeleteCourse(courseService))

	api.Post("/courses/:courseId/tees", middleware.RequireRole("admin"), durableIdempotency, handlers.CreateTee(courseService))
	api.Patch("/courses/:courseId/tees/:teeId", middleware.RequireRole("admin"), handlers.UpdateTee(courseService))
	api.Delete("/courses/:courseId/tees/:teeId", middleware.RequireRole("admin"), handlers.DeleteTee(courseService))

	api.Put("/courses/:courseId/tees/:teeId/holes", middleware.RequireRole("admin"), handlers.UpsertHoles(courseService))
	api.Patch("/courses/:courseId/tees/:teeId/holes/:holeNumber", middleware.RequireRole("admin"), handlers.UpdateHole(courseService))

	// External course import — search returns results without writing; import/refresh write to DB
	api.Post("/courses/search-external", middleware.RequireRole("admin"), handlers.SearchExternalCourse(courseService))
	api.Post("/courses/import-external", middleware.RequireRole("admin"), durableIdempotency, handlers.ImportExternalCourse(courseService))
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
	// Follow is a non-idempotent create (FollowUser returns ErrAlreadyFollowing on a duplicate);
	// durableIdempotency lets the client's savePost retry replay the original 2xx. Unfollow
	// (DELETE) is already idempotent, so it routes through savePut(DELETE) unwrapped.
	api.Post("/users/:userId/follow", durableIdempotency, handlers.FollowUser(userService))
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
