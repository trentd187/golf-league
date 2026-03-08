#!/usr/bin/env bash
# scripts/check-go-coverage.sh
#
# Enforces the "coverage ratchet" rule: no commit may lower Go test coverage.
#
# How it works:
#   1. Run the test suite and measure current coverage percentage.
#   2. Read the stored baseline from .go-coverage-baseline (repo root).
#   3. If current < baseline  → block the commit with a clear error.
#   4. If current >= baseline → allow the commit and auto-update the baseline
#      so the next commit can never go below today's level.
#
# The baseline file is committed to the repo and ratchets upward automatically.
# Coverage can only increase (or stay flat) over time — it can never decrease.
#
# Escape hatch (for adding code where tests will follow in the next commit):
#   LEFTHOOK=0 git commit -m "add scores handler (tests in next commit)"
#
# Manual run (from the backend/ directory):
#   cd backend && bash ../scripts/check-go-coverage.sh
#
# Packages excluded from coverage (require live infra or have no logic):
#   - internal/database  (requires a real PostgreSQL connection)
#   - internal/websocket (requires live WebSocket clients)
#   - internal/models    (struct definitions — no executable statements)
#   - internal/testutil  (test helpers — circular to test these)
#   - cmd/server         (main() entry point — just wires things together)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Path to the baseline file, relative to backend/ (where lefthook runs this).
# This file is committed to the repo so the baseline persists across clones.
BASELINE_FILE="../.go-coverage-baseline"

# The packages to measure. Add new packages here as they're created.
PACKAGES=(
  "github.com/trentd187/golf-league/internal/handlers"
  "github.com/trentd187/golf-league/internal/middleware"
)

# Coverage output file written to backend/coverage.out (relative to backend/, where
# lefthook runs this script). This path is intentionally persistent — it is read by
# SonarCloud to display line-level coverage in the dashboard. The file is generated
# fresh on every run, so stale data is never an issue. It is gitignored.
COVERAGE_FILE="coverage.out"

# ---------------------------------------------------------------------------
# Strict mode
# ---------------------------------------------------------------------------
# -e: exit immediately if any command fails unexpectedly
# -u: treat unset variables as errors (catches typos in variable names)
# -o pipefail: a pipe like "cmd | grep" fails if cmd fails, not just grep
set -euo pipefail

# ---------------------------------------------------------------------------
# Read the stored baseline
# ---------------------------------------------------------------------------

# If the baseline file doesn't exist (fresh clone before first commit),
# default to 0 so any positive coverage passes the initial check.
if [[ -f "$BASELINE_FILE" ]]; then
  # tr -d removes any trailing whitespace/newlines from the file contents
  BASELINE=$(cat "$BASELINE_FILE" | tr -d '[:space:]')
else
  BASELINE="0"
fi

# ---------------------------------------------------------------------------
# Run tests with coverage
# ---------------------------------------------------------------------------

echo ""
echo "==> Go coverage ratchet check"
echo "    Packages:  ${PACKAGES[*]}"
echo "    Baseline:  ${BASELINE}%"
echo ""

# Expand the packages array into a space-separated list for the go test command.
# IFS=" " sets the field separator so "${PACKAGES[*]}" joins with spaces.
IFS=" " PACKAGE_LIST="${PACKAGES[*]}"

# Run the test suite.
# -coverprofile: write per-statement hit counts to COVERAGE_FILE
# -covermode=count: record how many times each statement executes (more
#                   precise than the default "set" mode which just marks hit/miss)
# -timeout 60s: fail fast if any test hangs for more than 60 seconds
if ! go test \
    -coverprofile="$COVERAGE_FILE" \
    -covermode=count \
    -timeout 60s \
    ${PACKAGE_LIST}; then
  echo ""
  echo "✗ Tests are failing — fix them before committing."
  exit 1
fi

# ---------------------------------------------------------------------------
# Extract the total coverage percentage
# ---------------------------------------------------------------------------

# `go tool cover -func` prints a per-function breakdown plus a summary:
#   github.com/.../health.go:18:  HealthCheck  100.0%
#   total:                        (statements)    0.2%
#
# grep "^total:"  → isolate the summary line
# awk '{print $3} → take the 3rd whitespace-separated field (the percentage)
# tr -d '%'       → strip the "%" so we have a plain number like "0.2"
CURRENT=$(go tool cover -func="$COVERAGE_FILE" \
  | grep "^total:" \
  | awk '{print $3}' \
  | tr -d '%')

echo "    Current:   ${CURRENT}%"

# ---------------------------------------------------------------------------
# Compare current vs baseline
# ---------------------------------------------------------------------------

# bash only supports integer arithmetic, so we use awk for float comparison.
# awk exits 0 (success) when the BEGIN condition holds, 1 (failure) otherwise.
# The pattern "exit (condition) ? 0 : 1" maps true→0, false→1.

if awk "BEGIN { exit ($CURRENT + 0 >= $BASELINE + 0) ? 0 : 1 }"; then
  # ---- Coverage held or improved ----

  # Print whether we improved or stayed flat.
  if awk "BEGIN { exit ($CURRENT + 0 > $BASELINE + 0) ? 0 : 1 }"; then
    echo "    ✓ Coverage improved: ${BASELINE}% → ${CURRENT}% — baseline updated."
  else
    echo "    ✓ Coverage unchanged at ${CURRENT}%."
  fi

  # Write the new (higher or equal) value back to the baseline file.
  # This ratchets the floor upward — future commits can never go below this.
  echo "$CURRENT" > "$BASELINE_FILE"

  # Stage the updated baseline file so it travels with this commit.
  # Running `git add` inside a pre-commit hook is safe — lefthook handles
  # the hook lifecycle correctly and the staged change is included.
  git add "$BASELINE_FILE"

  echo ""
  exit 0

else
  # ---- Coverage dropped ----

  echo ""
  echo "✗ Coverage dropped: ${BASELINE}% → ${CURRENT}%"
  echo ""
  echo "  Your commit would lower test coverage below the recorded baseline."
  echo ""
  echo "  Options:"
  echo "    a) Add tests for the new/changed code, then re-commit."
  echo "       Run this to see what's uncovered:"
  echo "         cd backend && go test ./internal/handlers/... ./internal/middleware/... -v"
  echo ""
  echo "    b) Use the escape hatch if tests are coming in the next commit:"
  echo "         LEFTHOOK=0 git commit -m \"add scores handler (tests to follow)\""
  echo ""
  exit 1
fi
