---
name: coverage-check
description: Run backend Go and mobile Jest coverage and compare against the committed baselines (.go-coverage-baseline, .mobile-coverage-baseline). Use before declaring a task done, or whenever the user asks to "check coverage". Reports current vs. baseline for both stacks and flags any drop.
---

# coverage-check

Verify both coverage ratchets locally before the pre-commit hook fails.

## What this skill does

1. Runs Go coverage for `internal/handlers` + `internal/middleware`, parses the total %, compares to `.go-coverage-baseline`.
2. Runs Jest mobile coverage, parses the Statements %, compares to `.mobile-coverage-baseline`.
3. Reports both deltas. If either dropped, suggests the most likely cause (new untested handler, inline screen logic, missing bug-fix test) — does NOT auto-add tests.

The baseline files live at the repo root and are auto-updated upward by the pre-commit hook on improvement.

## Steps

### 1. Read baselines

```bash
cat /c/Users/trent/git-repos/golf-league/.go-coverage-baseline
cat /c/Users/trent/git-repos/golf-league/.mobile-coverage-baseline
```

### 2. Run backend coverage

From the `backend/` directory. `-count=1` is REQUIRED — without it the test cache replays a stale coverage profile and produces a wrong number.

```bash
cd /c/Users/trent/git-repos/golf-league/backend && \
go test -count=1 \
  -coverpkg=github.com/trentd187/golf-league/internal/handlers,github.com/trentd187/golf-league/internal/middleware \
  -coverprofile=coverage.out ./... && \
go tool cover -func=coverage.out | grep "^total:"
```

The last line is `total: (statements) XX.X%`. Extract the percentage.

### 3. Run mobile coverage

```bash
export PATH="/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm:$PATH" && \
cd /c/Users/trent/git-repos/golf-league/mobile && \
pnpm test:coverage
```

In the Jest output, find the `All files` row and read the `Stmts` column. That percentage is what the ratchet measures.

### 4. Compare and report

For each stack, compute `current - baseline`. Report in this format:

```
Backend:  baseline 24.9% → current 25.3%  (+0.4)  ✓
Mobile:   baseline 73.1% → current 71.8%  (-1.3)  ✗ DROP
```

If either dropped, name the most likely cause without guessing wildly:
- **Backend drop:** "A new handler was added without `_test.go`, or a new validation branch in an existing handler isn't covered. Run `go tool cover -func=coverage.out | sort -k3 -n | head` to find the lowest-covered functions."
- **Mobile drop:** "Likely inline logic added to a screen file (those are excluded from coverage, so any sibling utility/component change exposes them). Check `git diff` for non-trivial logic in `app/scorecard/`, `app/events/`, `app/rounds/`, `app/courses/`, and propose extracting it to `utils/` per the extract-first rule in `feedback_coverage_workflow.md`."

If both held or improved, say so in one line — don't elaborate.

## When to use

- Before claiming a task is done
- Before the user commits (since the pre-commit hook will fail otherwise)
- Whenever the user asks "check coverage" or "did coverage drop"
- Proactively after any change that adds a new handler, modifies a handler signature, or edits a mobile screen file

## When NOT to use

- For pure documentation/markdown-only changes
- For changes that only touch `mobile/docs/`, `backend/docs/`, or `CLAUDE.md`
- When already inside a coverage-related task and the numbers were just reported

## Output format

Keep the report to ~5 lines. The user wants a verdict, not a transcript. If both stacks pass, one line is fine: `Coverage holds: backend 25.3% (+0.4), mobile 73.4% (+0.3).`
