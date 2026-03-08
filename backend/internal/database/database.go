// Package database provides helpers for connecting to PostgreSQL and running migrations.
package database

import (
	"github.com/golang-migrate/migrate/v4"
	// Blank imports register side-effect drivers with the migrate library.
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// Connect opens a GORM database handle using the given DSN (connection string).
func Connect(dsn string) (*gorm.DB, error) {
	return gorm.Open(postgres.Open(dsn), &gorm.Config{})
}

// RunMigrations applies any pending "up" migrations from the migrations/ directory.
// The migrate library tracks applied migrations in schema_migrations so it never runs the same one twice.
func RunMigrations(dsn string) error {
	m, err := migrate.New("file://migrations", dsn)
	if err != nil {
		return err
	}

	// ErrNoChange means all migrations are already applied — not an error.
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return err
	}

	return nil
}
