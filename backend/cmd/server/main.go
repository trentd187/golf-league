// cmd/server/main.go
// Entry point for the Golf League API server.
// The cmd/server layout follows the Go convention: cmd/ holds executables,
// internal/ holds reusable packages not importable by other projects.
package main

import (
	"context"
	"log"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/gofiber/contrib/otelfiber"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"

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

	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}

	if err := database.RunMigrations(cfg.DatabaseURL); err != nil {
		log.Fatal("Failed to run migrations:", err)
	}

	// NewHub + go hub.Run() starts the WebSocket broadcast loop as a background goroutine
	// so it doesn't block the rest of startup.
	hub := websocket.NewHub()
	go hub.Run()

	// Initialise the full Grafana Cloud observability stack (logs, metrics, traces, profiling).
	// Components whose env vars are absent degrade to no-ops — server runs without credentials.
	obs, err := observability.Init(cfg, hub.ConnCount)
	if err != nil {
		log.Fatal("Failed to initialise observability:", err)
	}
	defer obs.Shutdown()

	// Route all stdlib slog output through our handler so app logs appear in Loki.
	slog.SetDefault(obs.Logger)
	// Register the default handler for package-level observability.LogInfo(...) calls in handlers.
	observability.SetDefault(obs.Handler())

	// GolfCourseAPIClient is created once and shared across requests.
	// GOLF_COURSE_API_KEY may be empty — handlers check and return 503 if called without a key.
	golfAPI := services.NewGolfCourseAPIClient(cfg.GolfCourseAPIKey)

	app := fiber.New(fiber.Config{
		AppName: "Golf League API",
	})

	app.Use(cors.New())

	// otelfiber auto-instruments every request as an OTel span.
	// Must be registered first so all subsequent middleware and handlers have span context.
	app.Use(otelfiber.Middleware())

	// Correlation middleware reads X-Correlation-ID from the request (or generates one),
	// attaches it to the active span, and writes X-Trace-ID to the response.
	// Must be registered after otelfiber so the span already exists.
	app.Use(middleware.Correlation())

	// HTTPMetrics records request counts and latency using OTel instruments.
	// Registered after otelfiber so span context is available.
	app.Use(middleware.HTTPMetrics(obs.Metrics))

	// GET /health — liveness check for Railway and load balancers; no auth, no DB.
	app.Get("/health", handlers.HealthCheck)

	// All routes under /api/v1 require a valid Clerk JWT.
	// app.Group applies the middleware to every route registered on the returned group.
	api := app.Group("/api/v1", middleware.Auth(cfg, db))

	// Telemetry — mobile clients POST structured logs here; backend proxies to Loki.
	// Requires a valid Clerk JWT (auth middleware above), so Loki credentials stay server-side.
	api.Post("/telemetry/logs", handlers.PostMobileLogs(obs.Handler()))

	// Event routes
	api.Get("/events", handlers.GetEvents(db))
	api.Post("/events", middleware.RequireRole("admin", "manager"), handlers.CreateEvent(db))

	api.Get("/events/:id", handlers.GetEvent(db))
	api.Patch("/events/:id", handlers.UpdateEvent(db))
	api.Delete("/events/:id", handlers.DeleteEvent(db))

	api.Get("/events/:id/members", handlers.GetEventMembers(db))
	api.Post("/events/:id/members", handlers.AddEventMember(db))
	api.Delete("/events/:id/members/:userId", handlers.RemoveEventMember(db))

	api.Get("/events/:id/rounds", handlers.GetEventRounds(db))
	api.Post("/events/:id/rounds", handlers.ScheduleEventRound(db))

	// Round routes — round IDs are globally unique, so these are top-level
	// GET /rounds must be registered before /rounds/:roundId so Fiber's router
	// doesn't treat "rounds" as a roundId parameter.
	api.Get("/rounds", handlers.GetMyRounds(db))
	api.Get("/rounds/:roundId", handlers.GetRound(db))
	api.Patch("/rounds/:roundId", handlers.UpdateRound(db))
	api.Delete("/rounds/:roundId", handlers.DeleteRound(db))
	api.Post("/rounds/:roundId/groups", handlers.CreateGroup(db))
	api.Patch("/rounds/:roundId/groups/:groupId", handlers.UpdateGroup(db))
	api.Delete("/rounds/:roundId/groups/:groupId", handlers.DeleteGroup(db))
	api.Post("/rounds/:roundId/groups/:groupId/members", handlers.AddGroupMember(db))
	api.Delete("/rounds/:roundId/groups/:groupId/members/:userId", handlers.RemoveGroupMember(db))

	// Score routes — permission enforced per-handler (group member, organizer, or admin)
	api.Get("/rounds/:roundId/scorecard", handlers.GetRoundScorecard(db))
	api.Put("/rounds/:roundId/players/:roundPlayerId/handicap", handlers.SetPlayerHandicap(db))
	api.Put("/rounds/:roundId/players/:roundPlayerId/scores", handlers.UpsertPlayerScores(db))
	api.Put("/rounds/:roundId/players/:roundPlayerId/hole-stats", handlers.UpsertHoleStats(db))

	// Course routes — GET open to any authenticated user; mutations require admin or manager
	api.Get("/courses", handlers.GetCourses(db))
	api.Post("/courses", middleware.RequireRole("admin", "manager"), handlers.CreateCourse(db))
	api.Get("/courses/:courseId", handlers.GetCourse(db))
	api.Patch("/courses/:courseId", middleware.RequireRole("admin", "manager"), handlers.UpdateCourse(db))

	api.Post("/courses/:courseId/tees", middleware.RequireRole("admin", "manager"), handlers.CreateTee(db))
	api.Patch("/courses/:courseId/tees/:teeId", middleware.RequireRole("admin", "manager"), handlers.UpdateTee(db))
	api.Delete("/courses/:courseId/tees/:teeId", middleware.RequireRole("admin", "manager"), handlers.DeleteTee(db))

	api.Put("/courses/:courseId/tees/:teeId/holes", middleware.RequireRole("admin", "manager"), handlers.UpsertHoles(db))
	api.Patch("/courses/:courseId/tees/:teeId/holes/:holeNumber", middleware.RequireRole("admin", "manager"), handlers.UpdateHole(db))

	// External course import — search returns results without writing; import/refresh write to DB
	api.Post("/courses/search-external", middleware.RequireRole("admin", "manager"), handlers.SearchExternalCourse(golfAPI))
	api.Post("/courses/import-external", middleware.RequireRole("admin", "manager"), handlers.ImportExternalCourse(db, golfAPI))
	api.Post("/courses/:courseId/refresh", middleware.RequireRole("admin", "manager"), handlers.RefreshCourse(db, golfAPI))

	// User routes
	api.Get("/users", handlers.GetUsers(db))
	api.Patch("/me/profile-image", handlers.UpdateProfileImage(cfg, db))

	// Start the server in a goroutine so we can listen for OS signals below.
	// SIGTERM is sent by Railway (and Docker) when the container is being stopped;
	// graceful shutdown flushes telemetry before the process exits.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)

	go func() {
		observability.LogInfo(context.Background(), "server.startup", "Server starting",
			"port", cfg.Port, "env", cfg.Env)
		if err := app.Listen(":" + cfg.Port); err != nil {
			log.Printf("Server listen error: %v", err)
		}
	}()

	<-quit

	observability.LogInfo(context.Background(), "server.shutdown", "Server shutting down")
	if err := app.Shutdown(); err != nil {
		log.Printf("Server shutdown error: %v", err)
	}
}
