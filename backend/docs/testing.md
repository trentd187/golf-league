# Backend Testing

## Setup

- Test runner: `go test` (built into Go)
- Assertions: `github.com/stretchr/testify` (in `go.mod`)
- Shared helpers: `backend/internal/testutil/testutil.go`

```bash
go test ./...                                    # all
go test ./internal/handlers/ -v                  # one package, verbose
go test ./internal/handlers/ -run TestHealthCheck -v  # one test
```

## File conventions

- Test files end in `_test.go`
- Package name: `<package>_test` (black-box style — only exported symbols accessible)
- Test name: `func TestSubject_Scenario(t *testing.T)`
- Test files live alongside the code they test

## Tests required for every new handler

**Every new handler file must ship with a `_test.go` file in the same commit.** The coverage ratchet in `scripts/check-go-coverage.sh` blocks any commit that lowers total coverage. Do not use `LEFTHOOK=0` to bypass — write the tests instead.

Minimum bar: cover every validation path reachable without a real database (invalid UUIDs, missing required fields, out-of-range values). Those paths are the first code executed on any bad request, so this alone is enough to hold coverage.

## Checklist when modifying existing handlers/models

1. **Existing tests pass?** `go test ./...`
2. **New Tier 1 testable path?** New required field, new UUID param, new enum check that returns before a DB call → add a test.
3. **DB-level only validation?** Some constraints (Postgres enums, FK constraints) are enforced by the DB, not Go code. Document with a comment in the handler rather than leaving a test gap unexplained.

`ScoringFormat` is the canonical case 3 example: the handler casts the raw string directly to `models.ScoringFormat` and GORM sends it to Postgres, which rejects unknown values via the enum constraint.

## Two-tier test strategy

### Tier 1 — No database (fast, always runnable)

Most validation branches return before any DB call, so `nil` can be passed as `*gorm.DB` safely. Build the Fiber app inline:

```go
app := fiber.New(fiber.Config{DisableStartupMessage: true})
app.Get("/courses/:courseId", handlers.GetCourse(nil)) // nil DB — UUID check returns first

req := httptest.NewRequest(http.MethodGet, "/courses/not-a-uuid", nil)
resp, err := app.Test(req, -1)
require.NoError(t, err)
assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
```

For JSON bodies, always set the Content-Type header (Fiber's `BodyParser` requires it):

```go
buf := bytes.NewBufferString(`{"name":""}`)
req := httptest.NewRequest(http.MethodPost, "/courses", buf)
req.Header.Set("Content-Type", "application/json")
resp, err := app.Test(req, -1)
```

Or copy the `doJSON` helper pattern from `courses_test.go` into your new test file — each test file is self-contained.

`testutil.NewTestApp` + `testutil.DoRequest` work for simple GET handlers (see `health_test.go`).

### Tier 2 — With database (integration tests, requires `TEST_DATABASE_URL`)

Not yet implemented. When needed: `testutil.NewTestDB(t)` will connect to a test PostgreSQL, run migrations, return a `*gorm.DB`. Tests in this tier should be in `*_integration_test.go` files and skipped when `TEST_DATABASE_URL` is not set.

## What to test (ordered by impact on coverage ratchet)

| Priority | Target | Tier |
|---|---|---|
| **Required** | Every validation branch reachable without a DB | 1 |
| High | Permission helpers (`isEventOrganizer`, `isRoundOrganizer`) | 1 |
| High | Score entry validation (handicap gate, group membership) | 1 |
| Medium | Handler happy paths (correct status + response shape) | 2 |
| Low | Additional error paths (404, 403) | 2 |

## Coverage ratchet

Baseline in `.go-coverage-baseline` (repo root, committed). Auto-updates upward when coverage improves; never decreases. Measured: `internal/handlers`, `internal/middleware`.

Before committing, run:
```bash
go test -count=1 -coverpkg=github.com/trentd187/golf-league/internal/handlers,github.com/trentd187/golf-league/internal/middleware -coverprofile=coverage.out ./... && go tool cover -func=coverage.out | grep "^total:"
```

Compare against `.go-coverage-baseline`. If it drops, add Tier 1 tests **in the same commit** — don't rely on auto-update to paper over the regression.

**`-count=1` is required.** Go's test cache replays the coverage profile from the last run. If any instrumented file changed since the cached run, the merged `coverage.out` miscounts total statements (observed: 19.4% reported instead of actual 24.9%). `-count=1` disables the cache and forces a fresh measurement every time.

## Common Tier 1 patterns (no DB needed)

- `uuid.Parse(c.Locals("userID"))` fails when no auth middleware in test → returns **401**. Applies to: `GetRound`, `UpdateRound`, `DeleteRound`, `AddGroupMember`, `RemoveGroupMember`, and any handler that reads `c.Locals("userID")` first.
- `parseCourseID` / `parseTeeID` reject bad UUIDs → returns **400** before the first DB call.
- `IsConfigured()` check on `GolfCourseAPIClient` with empty key → returns **503** before parsing the body.
- `BodyParser` with `Content-Type: text/plain` → returns **400** when handler validates body before any DB call.

## When Tier 1 patterns do NOT apply (require Tier 2)

Any handler that calls `findCourse(c, db, ...)`, `findTee(c, db, ...)`, or `db.First(...)` before body or UUID validation — passing `nil` DB will panic. Document these gaps with a comment in the handler.
