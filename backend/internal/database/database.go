// Package database provides helpers for connecting to PostgreSQL and running migrations.
// This file has two responsibilities:
//   1. Opening a database connection using GORM (an ORM — Object Relational Mapper)
//   2. Running SQL migration files to keep the database schema up to date
package database

import (
	// The migrate package reads and applies versioned SQL migration files.
	"github.com/golang-migrate/migrate/v4"
	// Blank imports (_) register "side effects" — they register drivers with the migrate
	// library without us needing to use them directly. This is a common Go pattern.
	// This registers the postgres database driver for migrate:
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	// This registers the "file://" source driver, allowing migrate to read .sql files from disk:
	_ "github.com/golang-migrate/migrate/v4/source/file"

	// gorm is an ORM (Object-Relational Mapper) for Go. It lets us work with database
	// records as Go structs instead of writing raw SQL for every operation.
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// Connect opens a connection to the PostgreSQL database using the given DSN
// (Data Source Name — also called a connection string or database URL).
// It returns a *gorm.DB which is the GORM database handle used for all queries,
// or an error if the connection could not be established.
//
// Example DSN: "postgres://user:password@localhost:5432/golf_league?sslmode=disable"
func Connect(dsn string) (*gorm.DB, error) {
	// gorm.Open takes a dialect (postgres) and a GORM config and returns the DB handle.
	// &gorm.Config{} is an empty config struct — we use all defaults here.
	return gorm.Open(postgres.Open(dsn), &gorm.Config{})
}

// RunMigrations applies any pending "up" migrations from the migrations/ directory.
// Migrations are numbered SQL files (e.g., 000001_initial_schema.up.sql) that define
// changes to the database schema. The migrate library tracks which have already run
// in a special table (schema_migrations) so it never applies the same migration twice.
func RunMigrations(dsn string) error {
	// Create a new migrator that reads .sql files from the local "migrations" directory
	// and applies them to the database at the given DSN.
	m, err := migrate.New("file://migrations", dsn)
	if err != nil {
		return err
	}

	// m.Up() runs all migrations that haven't been applied yet, in order.
	// migrate.ErrNoChange is returned when there are no new migrations to run — this is
	// not a real error, so we ignore it. Any other error (bad SQL, connection issues, etc.)
	// is a real problem and should stop the server from starting.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return err
	}

	return nil
}
