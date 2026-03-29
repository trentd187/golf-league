// cmd/server/main.go
// Entry point for the Golf League API server.
// The cmd/server layout follows the Go convention: cmd/ holds executables,
// internal/ holds reusable packages not importable by other projects.
package main

import (
	"log"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"

	"github.com/trentd187/golf-league/internal/config"
	"github.com/trentd187/golf-league/internal/database"
	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/middleware"
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

	// GolfCourseAPIClient is created once and shared across requests.
	// GOLF_COURSE_API_KEY may be empty — handlers check and return 503 if called without a key.
	golfAPI := services.NewGolfCourseAPIClient(cfg.GolfCourseAPIKey)

	app := fiber.New(fiber.Config{
		AppName: "Golf League API",
	})

	app.Use(logger.New())
	// cors.New() allows cross-origin requests — needed in development; lock down in production.
	app.Use(cors.New())

	// GET /health — liveness check for Railway and load balancers; no auth, no DB.
	app.Get("/health", handlers.HealthCheck)

	// All routes under /api/v1 require a valid Clerk JWT.
	// app.Group applies the middleware to every route registered on the returned group.
	api := app.Group("/api/v1", middleware.Auth(cfg, db))

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

	log.Printf("Starting server on port %s", cfg.Port)
	log.Fatal(app.Listen(":" + cfg.Port))
}
