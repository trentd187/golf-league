---
name: qa
description: Run post-push regression tests against the Railway develop deployment. Executes Hurl API tests (self-authenticating via Supabase), Playwright web regression, and Maestro mobile flows. Use after pushing to develop to verify nothing broke in the live environment.
---

# qa

Post-push regression suite. Runs against the deployed Railway develop environment to verify the live app is healthy after a push to `develop`.

## What this skill does

1. **Prerequisites check** — verify required tools and env vars before running anything
2. **Hurl API tests** — signs in via Supabase automatically, then smoke-tests the backend REST API; no manual token required
3. **Playwright web tests** — regression tests against the deployed web app in Chromium
4. **Maestro mobile tests** — flow tests on the connected Android device or emulator (skipped if no device detected)
5. **Summary** — results table across all three suites

## One-time setup

### Tools — all already installed
- Hurl 8.0.1 at `~/.hurl/`
- Playwright Chromium at `~/.playwright-browsers/`
- Maestro at `~/.maestro/`
- All PATH entries in `~/.bashrc`

### QA test user (one-time, in Supabase Dashboard)
The Hurl suite signs in with email+password. The app UI uses OTP, but Supabase supports both simultaneously on the same project.

1. Supabase Dashboard → Authentication → Users → **Add user**
2. Set an email (e.g. `qa@yourdomain.com`) and a strong password
3. The user is created immediately — no email verification needed via the dashboard

### variables.env
```bash
cp /c/Users/trent/git-repos/golf-league/backend/qa/variables.env.example \
   /c/Users/trent/git-repos/golf-league/backend/qa/variables.env
```
Fill in all five values:
- `QA_BASE_URL` — Railway develop backend URL (no trailing slash)
- `SUPABASE_URL` — Dashboard → Project Settings → Data API → Project URL
- `SUPABASE_PUBLISHABLE_KEY` — Dashboard → Project Settings → API → Publishable (anon) key
- `QA_TEST_EMAIL` — the QA test user's email
- `QA_TEST_PASSWORD` — the QA test user's password

### PLAYWRIGHT_BASE_URL
Add to `~/.bashrc`:
```bash
export PLAYWRIGHT_BASE_URL=https://your-railway-develop-web-url.railway.app
```

## Steps

### 1. Prerequisites check

```bash
export PATH="$PATH:/c/Users/trent/.hurl:/c/Users/trent/.maestro/bin"
export PATH="$PATH:/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm"

# Hurl
hurl --version >/dev/null 2>&1 || echo "MISSING: hurl not found at ~/.hurl"

# variables.env exists
test -f /c/Users/trent/git-repos/golf-league/backend/qa/variables.env \
  || echo "MISSING: backend/qa/variables.env (copy from variables.env.example and fill in values)"

# Required variables populated
for VAR in QA_BASE_URL SUPABASE_URL SUPABASE_PUBLISHABLE_KEY QA_TEST_EMAIL QA_TEST_PASSWORD; do
  grep -q "^${VAR}=.\+" /c/Users/trent/git-repos/golf-league/backend/qa/variables.env \
    || echo "MISSING: ${VAR} not set in variables.env"
done

# Playwright
(cd /c/Users/trent/git-repos/golf-league/mobile && npx playwright --version >/dev/null 2>&1) \
  || echo "MISSING: playwright not installed (run: cd mobile && pnpm exec playwright install chromium)"

# PLAYWRIGHT_BASE_URL
[ -n "$PLAYWRIGHT_BASE_URL" ] && echo "PLAYWRIGHT_BASE_URL: OK" \
  || echo "MISSING: PLAYWRIGHT_BASE_URL env var not set — add to ~/.bashrc"

# Maestro (optional — warn but don't fail)
maestro --version >/dev/null 2>&1 && echo "maestro: OK" \
  || echo "WARN: maestro not found — mobile tests will be skipped"
```

If any MISSING line appears (except the maestro warn), stop and report what to fix. Do not run tests with missing prerequisites.

### 2. Hurl API tests

Two files, run separately so captures and errors are scoped correctly.

**2a. Health (unauthenticated):**
```bash
export PATH="$PATH:/c/Users/trent/.hurl"
cd /c/Users/trent/git-repos/golf-league && \
hurl --variables-file backend/qa/variables.env \
  backend/qa/health.hurl \
  --test
```

**2b. Authenticated suite** — signs in automatically, no manual token needed:
```bash
export PATH="$PATH:/c/Users/trent/.hurl"
cd /c/Users/trent/git-repos/golf-league && \
hurl --variables-file backend/qa/variables.env \
  backend/qa/authenticated.hurl \
  --test
```

Pass = exit 0 and all entries show `[success]`. On failure, show the full Hurl error output (includes request, expected vs actual, and entry number). If step 1 of `authenticated.hurl` fails with 400 or 422, the test user credentials in `variables.env` are wrong — check `QA_TEST_EMAIL` and `QA_TEST_PASSWORD`.

### 3. Playwright web tests

```bash
export PATH="$PATH:/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm"
cd /c/Users/trent/git-repos/golf-league/mobile && \
PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL}" pnpm e2e:web
```

Pass = exit 0. Report pass/fail per spec file. On failure, report the test name, expected vs actual, and any screenshot path (saved to `mobile/test-results/`).

### 4. Maestro mobile tests

First check for a connected device:
```bash
adb devices
```

If no device is listed (other than the header line): skip with message "No Android device connected — mobile regression skipped."

If a device is connected:
```bash
export PATH="$PATH:/c/Users/trent/.maestro/bin"
cd /c/Users/trent/git-repos/golf-league/mobile && pnpm e2e:mobile
```

Pass = all flows exit 0. Report pass/fail per `.yaml` file.

### 5. Summary

Print a results table:

```
QA Results — develop
─────────────────────────────────────────────
Suite             Tests   Passed   Failed
─────────────────────────────────────────────
API (Hurl)            6        6        0
Web (Playwright)      4        4        0
Mobile (Maestro)      2        2        0   ← or "skipped (no device)"
─────────────────────────────────────────────
Overall: PASS
```

If any suite failed: list the failing test names and the first error message per test. Overall is FAIL even if only one test fails.

## When to use

- After pushing to `develop` — part of the standard session-end workflow
- When investigating a regression reported by the user
- When the Railway develop deployment was just rebuilt (after a push)
- When asked "run QA", "test the live app", or "check develop"

## When NOT to use

- Before pushing (that's `/ci`)
- Against `main` / production — QA_BASE_URL should always point to develop
- When Railway develop is down or mid-deploy (wait for health check to pass first)
