// Package database provides helpers for connecting to PostgreSQL and running migrations.
package database

import (
	"time"

	"github.com/golang-migrate/migrate/v4"
	// Blank imports register side-effect drivers with the migrate library.
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// PoolConfig bounds the database/sql connection pool. Without it Go defaults to UNLIMITED
// open connections and no lifetime, which let the backend exhaust Railway Postgres's
// connection cap under a live round and wedge (goroutines parked waiting for a connection).
type PoolConfig struct {
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
}

// GormConfig returns the GORM configuration used for EVERY connection — production and the
// Tier 2 testcontainers DB alike (internal/testutil/db.go calls this). It exists so the two
// cannot drift: a test database configured differently from production is a test that lies.
func GormConfig() *gorm.Config {
	return &gorm.Config{
		// TranslateError converts driver-specific errors into GORM's sentinels
		// (gorm.ErrDuplicatedKey, gorm.ErrForeignKeyViolated, ...). Without it a unique
		// violation arrives as an opaque *pq.Error, which is why services could not tell a
		// genuine conflict apart from a real DB fault and defaulted to reporting BOTH as a
		// benign 4xx — hiding outages. Services now branch on the sentinels; this is what
		// makes that possible.
		TranslateError: true,
	}
}

// Connect opens a GORM database handle using the given DSN and applies the pool bounds.
func Connect(dsn string, pool PoolConfig) (*gorm.DB, error) {
	db, err := gorm.Open(postgres.Open(dsn), GormConfig())
	if err != nil {
		return nil, err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(pool.MaxOpenConns)
	sqlDB.SetMaxIdleConns(pool.MaxIdleConns)
	sqlDB.SetConnMaxLifetime(pool.ConnMaxLifetime)
	sqlDB.SetConnMaxIdleTime(pool.ConnMaxIdleTime)
	return db, nil
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
