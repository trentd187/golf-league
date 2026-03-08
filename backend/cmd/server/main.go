// cmd/server/main.go
// This is the entry point for the Golf League API server.
// In Go, the "main" package and its "main()" function is where the program starts executing.
// The "cmd/server" directory follows a common Go convention: the cmd/ folder holds executable
// binaries, and internal/ holds reusable packages that are not meant to be imported by other projects.
package main

import (
	"log"

	// fiber is a fast HTTP web framework inspired by Express.js
	"github.com/gofiber/fiber/v2"
	// cors handles Cross-Origin Resource Sharing — allows the mobile app to talk to
	// the API even though they're running on different origins (hosts/ports)
	"github.com/gofiber/fiber/v2/middleware/cors"
	// logger prints request details (method, path, status, duration) to stdout
	"github.com/gofiber/fiber/v2/middleware/logger"

	// Internal packages — our own code, imported by module path
	"github.com/trentd187/golf-league/internal/config"
	"github.com/trentd187/golf-league/internal/database"
	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/middleware"
	"github.com/trentd187/golf-league/internal/websocket"
)

func main() {
	// Load configuration from environment variables (and optionally a .env file).
	// cfg is a pointer (*Config) containing all runtime settings like port, database URL, etc.
	cfg := config.Load()

	// Connect to the PostgreSQL database.
	// We store the returned *gorm.DB — it's used by middleware and handlers to run queries.
	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}

	// Run any pending SQL migration files (in the migrations/ directory).
	// Migrations are SQL scripts that create or alter tables. Running them on startup
	// ensures the database schema is always in sync when the server starts.
	if err := database.RunMigrations(cfg.DatabaseURL); err != nil {
		log.Fatal("Failed to run migrations:", err)
	}

	// Create a new WebSocket Hub and start it in a goroutine.
	// The Hub manages all live WebSocket connections — players watching live scores.
	// "go hub.Run()" starts Run() as a goroutine: a lightweight concurrent function
	// that runs in the background without blocking the rest of startup.
	hub := websocket.NewHub()
	go hub.Run()

	// Create a new Fiber app (our HTTP server).
	app := fiber.New(fiber.Config{
		AppName: "Golf League API",
	})

	// --- Global middleware ---
	// These run on every request before any route handler.
	// logger.New() logs each HTTP request: method, path, status code, and duration.
	app.Use(logger.New())
	// cors.New() allows requests from any origin (needed for the mobile app in development).
	// In production, lock this down to your specific domain.
	app.Use(cors.New())

	// --- Public routes (no auth required) ---
	// GET /health is a liveness check used by AWS ECS / load balancers to verify the server is running.
	app.Get("/health", handlers.HealthCheck)

	// --- Authenticated API routes ---
	// All routes under /api/v1 require a valid Clerk JWT.
	// middleware.Auth(cfg, db) validates the token AND syncs the user to our database.
	//
	// Route group pattern: app.Group(prefix, middlewares...) applies the middleware
	// to every route registered on the returned group — we don't have to repeat it per route.
	api := app.Group("/api/v1", middleware.Auth(cfg, db))

	// --- Event routes ---

	// Collection endpoints
	api.Get("/events", handlers.GetEvents(db))                                                // list (filtered by membership for non-admins)
	api.Post("/events", middleware.RequireRole("admin", "manager"), handlers.CreateEvent(db)) // create (admin/manager only)

	// Single-event endpoints — :id is the event UUID
	api.Get("/events/:id", handlers.GetEvent(db))       // detail view + members list
	api.Patch("/events/:id", handlers.UpdateEvent(db))  // partial update including status (organizers only)
	api.Delete("/events/:id", handlers.DeleteEvent(db)) // permanently delete event + all children (organizers only)

	// Members sub-resource
	api.Get("/events/:id/members", handlers.GetEventMembers(db))              // list all members
	api.Post("/events/:id/members", handlers.AddEventMember(db))              // add a member (organizers only)
	api.Delete("/events/:id/members/:userId", handlers.RemoveEventMember(db)) // remove a member (organizers only)

	// Rounds sub-resource (scoped to an event)
	api.Get("/events/:id/rounds", handlers.GetEventRounds(db))      // list rounds for the event
	api.Post("/events/:id/rounds", handlers.ScheduleEventRound(db)) // schedule a new round (organizers only)

	// Round detail and group management (top-level /rounds routes — round IDs are globally unique)
	api.Get("/rounds/:roundId", handlers.GetRound(db))                                             // round detail with groups + players (any member)
	api.Patch("/rounds/:roundId", handlers.UpdateRound(db))                                        // edit round name/course/date/format (organizers only)
	api.Delete("/rounds/:roundId", handlers.DeleteRound(db))                                       // delete round + all children (organizers only)
	api.Post("/rounds/:roundId/groups/:groupId/members", handlers.AddGroupMember(db))              // add player to group (organizers only)
	api.Delete("/rounds/:roundId/groups/:groupId/members/:userId", handlers.RemoveGroupMember(db)) // remove player from group (organizers only)

	// --- User routes ---
	api.Get("/users", handlers.GetUsers(db))                             // all users except the caller (powers the add-member picker)
	api.Patch("/me/profile-image", handlers.UpdateProfileImage(cfg, db)) // profile photo upload (proxied to Clerk Backend API)

	// Start listening for HTTP connections on the configured port.
	// ":" + cfg.Port produces a string like ":8080" — listen on all network interfaces.
	log.Printf("Starting server on port %s", cfg.Port)
	log.Fatal(app.Listen(":" + cfg.Port))
}
