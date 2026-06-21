---
name: qa
description: Run post-push regression tests against the Railway develop deployment. Executes Hurl API tests (self-authenticating via Supabase) and Playwright web regression. Use after pushing to develop to verify nothing broke in the live environment.
---

# qa

Post-push regression suite. Runs against the deployed Railway develop environment to verify the live app is healthy after a push to `develop`.

## What this skill does

1. **Prerequisites check** — verify required tools and env vars before running anything
2. **Grow the suite** — add exactly one backend + one frontend test from `backend/qa/TEST_BACKLOG.md` before running, so coverage compounds every session
3. **Hurl API tests** — signs in via Supabase automatically, then smoke-tests the backend REST API; no manual token required
4. **Playwright web tests** — regression tests against the deployed web app in Chromium (public + authenticated projects)
5. **Summary** — results table across both suites
6. **Commit** — when the new tests pass, commit them to `develop`

> **The suite grows by one test per side, per run.** `backend/qa/TEST_BACKLOG.md` holds two
> prioritized checklists. Each `/qa` run implements the first unchecked backend item and
> the first unchecked frontend item, validates them against live, checks them off, and
> commits. Read that file's rules before authoring (self-cleaning mutations, QA user is a
> normal `user`, `*.auth.spec.ts` naming, etc.).

> **Mobile (Maestro) testing is deferred.** The emulator-based Maestro flows were
> removed from this suite — mobile regression will be reintroduced later using real
> device testing rather than the `Pixel_7` AVD.

## One-time setup

### Tools — all already installed
- Hurl 8.0.1 at `~/.hurl/`
- Playwright Chromium at `~/.playwright-browsers/`
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
export PATH="$PATH:/c/Users/trent/.hurl"
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
```

If any MISSING line appears, stop and report what to fix. Do not run tests with missing prerequisites.

### 2. Grow the suite (add one backend + one frontend test)

Do this **after** the prerequisites pass (never author tests against a broken env) and
**before** running the suites.

1. Read [`backend/qa/TEST_BACKLOG.md`](../../../backend/qa/TEST_BACKLOG.md) and its **rules**
   section. Take the **first unchecked backend item** and the **first unchecked frontend
   item**. If one list is fully checked, skip that side and note "backlog empty — add more
   candidates." If an item is **blocked** (e.g. a round flow needs a seeded course that
   develop lacks), note it and take the next unchecked item.
2. **Backend item** → a new self-contained `backend/qa/<name>.hurl` file. Repeat the
   Supabase sign-in step from `authenticated.hurl` to capture `{{access_token}}`. Mutating
   flows must be **self-cleaning** (create → assert → `DELETE`, ideally ending with a
   `GET … → 404`). See `backend/qa/events_crud.hurl` for the pattern.
3. **Frontend item** → a new `mobile/e2e/web/<name>.spec.ts` (public) or
   `mobile/e2e/web/<name>.auth.spec.ts` (needs a signed-in session). Follow `auth.spec.ts`
   for public specs and `events.auth.spec.ts` for authenticated ones.
4. Check both items off in `TEST_BACKLOG.md` (append the date and the new file path).

### 3. Hurl API tests

Run all `.hurl` files via a glob so newly added files are picked up automatically. In
`--test` mode each file is independent (its own sign-in + captures).

```bash
export PATH="$PATH:/c/Users/trent/.hurl"
cd /c/Users/trent/git-repos/golf-league && \
hurl --variables-file backend/qa/variables.env \
  --test backend/qa/*.hurl
```

Pass = exit 0 and all entries show `[success]`. On failure, show the full Hurl error output (includes request, expected vs actual, the file, and entry number). If the sign-in entry of an authenticated file fails with 400 or 422, the test user credentials in `variables.env` are wrong — check `QA_TEST_EMAIL` and `QA_TEST_PASSWORD`.

### 4. Playwright web tests

The authenticated specs need the QA user's Supabase session. The `auth.setup.ts` setup
project reads the credentials from the environment, so export them from `variables.env`
first (and pre-create the storage-state dir). `set -a` exports every var the file assigns.

```bash
export PATH="$PATH:/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm"
cd /c/Users/trent/git-repos/golf-league/mobile && \
set -a && . ../backend/qa/variables.env && set +a && \
mkdir -p e2e/.auth && \
PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL}" pnpm e2e:web
```

Pass = exit 0. Playwright runs three projects: `setup` (signs in, writes
`e2e/.auth/user.json`), `chromium` (public `*.spec.ts`), and `chromium-auth`
(`*.auth.spec.ts`, reuses the injected session). Report pass/fail per spec file. On
failure, report the test name, expected vs actual, and any screenshot path (saved to
`mobile/test-results/`). If only the `setup` project fails, the QA credentials or the
injected-session format is the problem — fix `auth.setup.ts`, not the specs.

### 5. Summary

Print a results table:

```
QA Results — develop
─────────────────────────────────────────────
Suite             Tests   Passed   Failed
─────────────────────────────────────────────
API (Hurl)            7        7        0   (+1 new: events_crud)
Web (Playwright)      5        5        0   (+1 new: events.auth)
─────────────────────────────────────────────
Overall: PASS
```

Annotate the two tests added this run as "(new)". Distinguish failures:
- A **newly added** test that fails is almost always a test-authoring bug — fix the test
  and re-run; **do not commit it red**, and do not check it off in the backlog.
- A **pre-existing** test that fails is a real regression — report it (test name + first
  error) and do not mask it. Overall is FAIL even if only one test fails.

### 6. Commit the new tests

When the suite is green (or the only failures are flagged pre-existing regressions and the
two new tests pass), commit the additions to `develop`:

```bash
cd /c/Users/trent/git-repos/golf-league && \
git add backend/qa/*.hurl backend/qa/TEST_BACKLOG.md mobile/e2e/web/ mobile/playwright.config.ts && \
git commit -m "qa: grow regression suite (<backend-id> + <frontend-id>)" && \
git push origin develop
```

The mobile lefthook hooks (typecheck + lint) run on the new `.ts` spec — that is intended
validation. The e2e specs are outside the Jest coverage set, so the coverage ratchet is
unaffected. Never commit a red newly-added test or the `e2e/.auth/` session state (it is
gitignored).

## When to use

- After pushing to `develop` — part of the standard session-end workflow
- When investigating a regression reported by the user
- When the Railway develop deployment was just rebuilt (after a push)
- When asked "run QA", "test the live app", or "check develop"

## When NOT to use

- Before pushing (that's `/ci`)
- Against `main` / production — QA_BASE_URL should always point to develop
- When Railway develop is down or mid-deploy (wait for health check to pass first)
