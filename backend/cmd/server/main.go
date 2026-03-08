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
	api.Post("/rounds/:roundId/groups/:groupId/members", handlers.AddGroupMember(db))
	api.Delete("/rounds/:roundId/groups/:groupId/members/:userId", handlers.RemoveGroupMember(db))

	// User routes
	api.Get("/users", handlers.GetUsers(db))
	api.Patch("/me/profile-image", handlers.UpdateProfileImage(cfg, db))

	log.Printf("Starting server on port %s", cfg.Port)
	log.Fatal(app.Listen(":" + cfg.Port))
}
