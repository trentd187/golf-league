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
	// cors handles Cross-Origin Resource Sharing — this allows the mobile app to talk to
	// the API even though they're running on different origins (hosts/ports)
	"github.com/gofiber/fiber/v2/middleware/cors"
	// logger prints request details (method, path, status, duration) to stdout
	"github.com/gofiber/fiber/v2/middleware/logger"

	// Internal packages — these are our own code, imported by module path
	"github.com/trentd187/golf-league/internal/config"
	"github.com/trentd187/golf-league/internal/database"
	"github.com/trentd187/golf-league/internal/handlers"
	"github.com/trentd187/golf-league/internal/websocket"
)

func main() {
	// Load configuration from environment variables (and optionally a .env file).
	// cfg is a pointer (*Config) containing all runtime settings like port, database URL, etc.
	cfg := config.Load()

	// Connect to the PostgreSQL database using the connection string from config.
	// The underscore (_) discards the returned *gorm.DB — we only care if there's an error here.
	// log.Fatal prints the error and then calls os.Exit(1), stopping the program immediately.
	if _, err := database.Connect(cfg.DatabaseURL); err != nil {
		log.Fatal("Failed to connect to database:", err)
	}

	// Run any pending SQL migration files (in the migrations/ directory).
	// Migrations are SQL scripts that create or alter tables. Running them on startup
	// ensures the database schema is always up to date when the server starts.
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
	// fiber.Config lets us set options; here we just give the API a display name.
	app := fiber.New(fiber.Config{
		AppName: "Golf League API",
	})

	// Register global middleware — these run on every request before route handlers.
	// logger.New() logs each HTTP request with its method, path, status code, and duration.
	app.Use(logger.New())
	// cors.New() with default options allows requests from any origin.
	// This is needed because the mobile app and server run on different addresses.
	app.Use(cors.New())

	// Register routes — each line maps an HTTP method + path to a handler function.
	// GET /health is a simple liveness check used by infrastructure to verify the server is running.
	app.Get("/health", handlers.HealthCheck)

	// Start listening for HTTP connections on the configured port.
	// ":" + cfg.Port produces a string like ":8080", which means "listen on all network interfaces at port 8080".
	// log.Fatal will exit the program if the server fails to start (e.g., port is already in use).
	log.Printf("Starting server on port %s", cfg.Port)
	log.Fatal(app.Listen(":" + cfg.Port))
}
