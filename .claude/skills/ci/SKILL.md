---
name: ci
description: Run the full local CI suite — backend lint + tests + coverage, mobile typecheck + lint + tests + coverage, then SonarCloud scan. Use before committing to catch the same failures that would block GitHub Actions. Replaces coverage-check.
---

# ci

Run every local quality gate before committing. Mirrors the GitHub Actions CI pipeline step-for-step so there are no surprises on push.

## What this skill does

1. **Backend lint** — golangci-lint across all Go packages
2. **Backend tests + coverage** — `go test` with `-count=1`, coverage ratchet enforced via `scripts/check-go-coverage.sh`
3. **Mobile typecheck** — `tsc --noEmit` (zero output means pass)
4. **Mobile lint** — `expo lint` (ESLint 9 flat config)
5. **Mobile tests + coverage** — Jest with `--coverage`, ratchet enforced via `scripts/check-mobile-coverage.sh`
6. **SonarCloud scan** — `sonar-scanner` against sonarcloud.io (requires one-time setup below)

Stop at the first failure and report which step failed. Do not skip steps silently.

## One-time setup

### SonarCloud scanner (Windows — already installed)
Already installed at `~/.sonar-scanner/`. The bin directory is added to PATH in `~/.bashrc`. No action needed unless you need to upgrade.

### SONAR_TOKEN
Generate at sonarcloud.io → Your account → Security → Generate Tokens. Add to your shell profile:
```bash
export SONAR_TOKEN=your-token-here
```

## Steps

### 1. Backend lint

```bash
cd /c/Users/trent/git-repos/golf-league/backend && golangci-lint run ./...
```

Pass = no output (or only info-level lines). Any `[error]` or `[warning]` lines = FAIL. Report the first error and stop.

### 2. Backend tests + coverage

```bash
cd /c/Users/trent/git-repos/golf-league/backend && \
go test -count=1 \
  -coverpkg=github.com/trentd187/golf-league/internal/handlers,github.com/trentd187/golf-league/internal/middleware,github.com/trentd187/golf-league/internal/services \
  -coverprofile=coverage.out ./... && \
go tool cover -func=coverage.out | grep "^total:"
```

`-count=1` is REQUIRED — without it the test cache replays a stale profile and produces a wrong number. Then enforce the ratchet:

```bash
cd /c/Users/trent/git-repos/golf-league/backend && bash ../scripts/check-go-coverage.sh
```

Pass = script exits 0. FAIL = script exits non-zero (prints the delta and the baseline). Report the percentage delta.

### 3. Mobile typecheck

```bash
export PATH="/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm:$PATH" && \
cd /c/Users/trent/git-repos/golf-league/mobile && npx tsc --noEmit
```

Pass = exit 0, no output. Any TypeScript error = FAIL. Report the first error with file + line.

### 4. Mobile lint

```bash
export PATH="/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm:$PATH" && \
cd /c/Users/trent/git-repos/golf-league/mobile && npx expo lint
```

Pass = exit 0. Any ESLint error (not warning) = FAIL. Warnings are allowed — do not fail on warn-level rules like `react-native/no-inline-styles`.

### 5. Mobile tests + coverage

```bash
export PATH="/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm:$PATH" && \
cd /c/Users/trent/git-repos/golf-league/mobile && pnpm test:coverage
```

Then enforce the ratchet:

```bash
cd /c/Users/trent/git-repos/golf-league && bash scripts/check-mobile-coverage.sh
```

Pass = script exits 0. FAIL = coverage dropped below baseline. Report the Statements % delta.

### 6. SonarCloud scan

First verify prerequisites:
```bash
export PATH="$PATH:/c/Users/trent/.sonar-scanner/sonar-scanner-8.1.0.6389-windows-x64/bin"
sonar-scanner.bat --version 2>&1 | head -1 && echo "SONAR_TOKEN=${SONAR_TOKEN:0:4}..."
```

If `sonar-scanner.bat` is not found: FAIL with message "sonar-scanner not found — expected at ~/.sonar-scanner/".
If `SONAR_TOKEN` is empty: FAIL with message "SONAR_TOKEN is not set — add `export SONAR_TOKEN=your-token` to ~/.bashrc".

Both present — run from the **repo root** (so sonar-project.properties is found):
```bash
export PATH="$PATH:/c/Users/trent/.sonar-scanner/sonar-scanner-8.1.0.6389-windows-x64/bin"
cd /c/Users/trent/git-repos/golf-league && sonar-scanner.bat
```

Pass = exit 0 and output contains "ANALYSIS SUCCESSFUL". FAIL = non-zero exit or "ANALYSIS FAILED" in output.

## Report format

After all steps complete, print a concise table:

```
CI Results
──────────────────────────────────────────
 1. Backend lint        ✓
 2. Backend tests       ✓  67.9% (+0.0)
 3. Mobile typecheck    ✓
 4. Mobile lint         ✓
 5. Mobile tests        ✓  84.5% (+0.0)
 6. SonarCloud          ✓
──────────────────────────────────────────
All checks passed.
```

On any failure, stop at the failed step, show the error output (trimmed to ~10 lines), and do NOT run subsequent steps.

## When to use

- After every change, before committing
- Whenever the user asks "run CI", "check everything", or "is this ready to commit"
- Proactively after adding a handler, modifying a service, or editing a mobile screen

## When NOT to use

- For pure documentation/markdown-only changes (`.md` files only)
- When already in the middle of a failing step's fix loop — just re-run the specific failing step
