// testutil/db.go
// Tier 2 (integration) test helpers. NewTestDB spins up a one-time ephemeral
// Postgres container per `go test` invocation via testcontainers-go, applies
// every migration, and returns a *gorm.DB. The container is shared across all
// tests in the process; each call truncates every table CASCADE so individual
// tests start with a clean slate.
//
// Tests using NewTestDB MUST NOT call t.Parallel() — TRUNCATE is global and
// would race across goroutines sharing the same database.
//
// Requirements:
//   - Docker daemon running (testcontainers connects to it). If Docker is
//     unavailable the test fails with a clear error rather than silently skipping.
//
// Why testcontainers (vs. a persistent local DB):
//   - Hermetic: every `go test` run starts from a fresh schema. No state leaks
//     between runs and no risk of accidentally pointing at a dev or prod DB.
//   - Zero per-developer setup beyond "Docker installed".
//   - Identical behavior locally and in CI.
package testutil

import (
	"context"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres" // register postgres driver
	_ "github.com/golang-migrate/migrate/v4/source/file"       // register file source
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

// setupOnce gates the one-time container start + migration step so the cost
// is paid once per `go test` invocation, regardless of how many tests call
// NewTestDB.
var setupOnce sync.Once

var (
	sharedDB *gorm.DB // shared GORM handle returned by every NewTestDB call
	setupErr error    // captured by setupOnce; surfaced from every NewTestDB call
)

// NewTestDB returns a *gorm.DB connected to an ephemeral Postgres test
// container, with all migrations applied and every table truncated.
//
// On the very first call per process, this:
//  1. Starts a postgres:16-alpine container via testcontainers-go.
//  2. Applies every migration in backend/migrations.
//  3. Opens a shared GORM handle pointed at the container.
//
// On every call (first and subsequent) it TRUNCATEs every public-schema table
// CASCADE so each test starts empty.
//
// The returned DB is shared — do not Close it. Container teardown is handled
// by testcontainers' Ryuk reaper when the test process exits.
func NewTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	setupOnce.Do(setupContainer)
	require.NoError(t, setupErr, "test container setup failed (is Docker running?)")

	truncateAll(t, sharedDB)
	return sharedDB
}

// setupContainer is invoked exactly once via setupOnce.
// It starts the Postgres container, runs migrations, opens GORM.
// Any failure is captured in setupErr and surfaced to every later NewTestDB call.
func setupContainer() {
	ctx := context.Background()

	ctr, err := tcpostgres.Run(ctx,
		"postgres:16-alpine",
		tcpostgres.WithDatabase("golf_league_test"),
		tcpostgres.WithUsername("postgres"),
		tcpostgres.WithPassword("postgres"),
		// Postgres logs the "ready to accept connections" line twice during init —
		// once for the temporary bootstrap server, once for the real one. Wait for
		// the second occurrence so migrations don't race the init script.
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second),
		),
	)
	if err != nil {
		setupErr = fmt.Errorf("start postgres container: %w", err)
		return
	}

	dsn, err := ctr.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		setupErr = fmt.Errorf("connection string: %w", err)
		return
	}

	// Locate migrations relative to this source file so the helper works no
	// matter which package's directory `go test` runs from.
	_, thisFile, _, _ := runtime.Caller(0)
	migrationsDir := filepath.Join(filepath.Dir(thisFile), "..", "..", "migrations")
	sourceURL := "file://" + filepath.ToSlash(migrationsDir) // migrate wants forward slashes

	m, err := migrate.New(sourceURL, dsn)
	if err != nil {
		setupErr = fmt.Errorf("open migrations: %w", err)
		return
	}
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		setupErr = fmt.Errorf("apply migrations: %w", err)
		return
	}

	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		setupErr = fmt.Errorf("open gorm: %w", err)
		return
	}
	sharedDB = db
}

// truncateAll wipes every public-schema table except schema_migrations so each
// test starts with a known-empty state. CASCADE handles foreign keys.
func truncateAll(t *testing.T, db *gorm.DB) {
	t.Helper()

	var tables []string
	err := db.Raw(`
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
	`).Scan(&tables).Error
	require.NoError(t, err, "list tables")

	if len(tables) == 0 {
		return
	}

	quoted := make([]string, len(tables))
	for i, name := range tables {
		quoted[i] = `"` + name + `"`
	}
	require.NoError(t,
		db.Exec("TRUNCATE TABLE "+strings.Join(quoted, ", ")+" RESTART IDENTITY CASCADE").Error,
		"truncate test tables",
	)
}
