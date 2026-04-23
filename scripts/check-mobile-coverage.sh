#!/usr/bin/env bash
# scripts/check-mobile-coverage.sh
#
# Enforces the "coverage ratchet" rule for the mobile (React Native/Expo) app:
# no commit may lower Jest statement coverage below the stored baseline.
#
# How it works:
#   1. Run Jest with --coverage and parse the Statements percentage.
#   2. Read the stored baseline from .mobile-coverage-baseline (repo root).
#   3. If current < baseline  → block the push with a clear error.
#   4. If current >= baseline → allow the push and auto-update the baseline.
#
# The baseline file is committed to the repo and ratchets upward automatically.
# Coverage can only increase (or stay flat) over time — it can never decrease.
#
# Escape hatch (for adding code where tests will follow in the next commit):
#   LEFTHOOK=0 git push
#
# Manual run (from the mobile/ directory):
#   cd mobile && bash ../scripts/check-mobile-coverage.sh
#
# Coverage metric: Jest "Statements" percentage (matches Go's per-statement model).
# --passWithNoTests: prevents blocking pushes before any test files exist.

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Path to the baseline file, relative to mobile/ (where lefthook runs this).
BASELINE_FILE="../.mobile-coverage-baseline"

# ---------------------------------------------------------------------------
# Strict mode
# ---------------------------------------------------------------------------
set -euo pipefail

# ---------------------------------------------------------------------------
# Ensure Node.js is on PATH (Git Bash on Windows does not include it by default)
# ---------------------------------------------------------------------------
export PATH="/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm:$PATH"

# ---------------------------------------------------------------------------
# Read the stored baseline
# ---------------------------------------------------------------------------

if [[ -f "$BASELINE_FILE" ]]; then
  BASELINE=$(cat "$BASELINE_FILE" | tr -d '[:space:]')
else
  BASELINE="0"
fi

# ---------------------------------------------------------------------------
# Run Jest with coverage
# ---------------------------------------------------------------------------

echo ""
echo "==> Mobile coverage ratchet check"
echo "    Baseline:  ${BASELINE}%"
echo ""

# --coverage:               collect coverage data
# --coverageReporters=text-summary: print a compact summary to stdout
# --passWithNoTests:        don't fail when no test files exist yet
# CI=true:                  suppress interactive prompts (watches, progress bars)
JEST_OUTPUT=$(CI=true npx jest \
  --coverage \
  --coverageReporters=text-summary \
  --passWithNoTests \
  2>&1) || {
  echo "$JEST_OUTPUT"
  echo ""
  echo "✗ Tests are failing — fix them before pushing."
  exit 1
}

echo "$JEST_OUTPUT"

# ---------------------------------------------------------------------------
# Extract the Statements percentage from Jest's text-summary output
# ---------------------------------------------------------------------------
# text-summary emits a line like:
#   Statements   : 45.28% ( 124/274 )
# We grep for "Statements", take the second field (the "45.28%"), strip the "%".

CURRENT=$(echo "$JEST_OUTPUT" \
  | grep "Statements" \
  | awk -F ':' '{print $2}' \
  | awk '{print $1}' \
  | tr -d '%')

# If Jest emitted no coverage (e.g. no source files matched collectCoverageFrom), treat as 0.
if [[ -z "$CURRENT" ]]; then
  CURRENT="0"
fi

echo ""
echo "    Current:   ${CURRENT}%"

# ---------------------------------------------------------------------------
# Compare current vs baseline
# ---------------------------------------------------------------------------

if awk "BEGIN { exit ($CURRENT + 0 >= $BASELINE + 0) ? 0 : 1 }"; then
  # ---- Coverage held or improved ----

  if awk "BEGIN { exit ($CURRENT + 0 > $BASELINE + 0) ? 0 : 1 }"; then
    echo "    ✓ Coverage improved: ${BASELINE}% → ${CURRENT}% — baseline updated."
  else
    echo "    ✓ Coverage unchanged at ${CURRENT}%."
  fi

  echo "$CURRENT" > "$BASELINE_FILE"

  # Stage the updated baseline so it travels with the push.
  git add "$BASELINE_FILE"

  echo ""
  exit 0

else
  # ---- Coverage dropped ----

  echo ""
  echo "✗ Coverage dropped: ${BASELINE}% → ${CURRENT}%"
  echo ""
  echo "  Your push would lower mobile test coverage below the recorded baseline."
  echo ""
  echo "  Options:"
  echo "    a) Add tests for the new/changed code, then re-push."
  echo "       Run this to see what's uncovered:"
  echo "         cd mobile && pnpm test:coverage"
  echo ""
  echo "    b) Use the escape hatch if tests are coming in the next commit:"
  echo "         LEFTHOOK=0 git push"
  echo ""
  exit 1
fi
