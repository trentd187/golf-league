---
name: sre
description: Act as a site reliability engineer for the live app. Investigate bugs AND performance regressions end-to-end before fixing. For web/backend: fetch the live URL, grep the JS bundle for known failure patterns (import.meta, SyntaxError sources), then query Sentry (Issues for errors, Logs for log-level events, Spans/Profiles for slow calls and latency outliers). For mobile: check ADB for devices, launch Expo, tail Metro/device logs, and pull the same Sentry signals. Surfaces both bugfixes and performance fixes with a specific file:line to change.
---

# sre

Investigate the live app as a site reliability engineer: find the **bugs** (errors, crashes, broken pages) *and* the **performance problems** (slowest endpoints, N+1 queries, latency outliers, regressions) before fixing them. The skill surfaces root causes and perf hotspots; Claude then fixes them.

## Invocation

```
/sre            — full sweep: web + mobile, reliability + performance
/sre web        — web/backend only
/sre mobile     — mobile only
/sre perf       — performance-only sweep across backend + frontend
```

If no argument is given, check web first, then mobile, and run the performance pass for each.

## Sentry coordinates

One vendor for errors, logs, traces, and profiles ([backend/docs/observability.md](../../../backend/docs/observability.md), [mobile/docs/observability.md](../../../mobile/docs/observability.md)).

| Field | Value |
|---|---|
| `organizationSlug` | `trent-dailey` |
| `regionUrl` | `https://us.sentry.io` |
| Backend project | `golf-league-backend` |
| Mobile + web project | `golf-league-frontend` |

Use the `mcp__sentry__*` tools — pass the org slug and region URL above. Datasets that matter here: **`errors`** (grouped into Issues), **`logs`** (searchable, `event:`/`event_type_label` facets), **`spans`** (per-operation latency for performance work), **`profiles`** (frontend CPU/wall-time samples — backend profiling isn't shipped yet).

---

## Web investigation

### Step 1 — Fetch the live page

Use WebFetch or curl to retrieve the page HTML. Note:
- HTTP status code (anything other than 200 is immediately reportable)
- Whether the body has a `<div id="root">` with content or is empty (blank white page)
- The JS bundle src path (the hash tells us if the bundle was rebuilt since the last deploy)

```bash
curl -s -o /dev/null -w "%{http_code}" https://golf-web-develop.up.railway.app/
curl -s "https://golf-web-develop.up.railway.app/" | grep -o 'src="[^"]*\.js"'
```

### Step 2 — Grep the JS bundle for known bad patterns

Fetch the JS bundle (URL from step 1) and grep for patterns that break classic-script execution:

```bash
BUNDLE_URL="https://golf-web-develop.up.railway.app/<path-from-step-1>"
curl -s "$BUNDLE_URL" | grep -oE 'import\.meta\.[a-zA-Z]+' | sort | uniq -c | sort -rn
```

**Known failure patterns:**
| Pattern | Cause | Fix |
|---|---|---|
| `import.meta.url` | @supabase/realtime-js not in Metro transformIgnorePatterns | Add `@supabase` to metro.config.js exception list |
| `import.meta.env` | zustand v5 devtools not in Metro transformIgnorePatterns, or babel-plugin-transform-import-meta not handling it | Add inline `importMetaEnvPlugin` to babel.config.js |
| `import.meta.hot` | Vite HMR code leaked into bundle | Add package to Metro exception list |

Any `import.meta.*` in the live bundle = SyntaxError = blank white page. Fix all before deploying.

### Step 3 — Check if Caddy is healthy

```bash
curl -s -o /dev/null -w "%{http_code}" https://golf-web-develop.up.railway.app/health
```

200 = Caddy running. Non-200 or timeout = container crash or port misconfiguration.

### Step 4 — Sentry: frontend Issues and error Logs

Pull what the live web session is actually throwing.

- **Grouped errors** — `mcp__sentry__search_issues` against `golf-league-frontend`:
  - `query: "is:unresolved environment:development"`, `sort: "freq"` for the loudest open bugs, or `sort: "new"` / `firstSeen:-24h` for fresh regressions after a deploy.
- **Error-level logs** — `mcp__sentry__search_events` with `dataset: "logs"`, e.g. `query: "level:error"` or filter by the dotted `event:` facet (`auth.otp.error`, etc.). Logs don't consume Issues quota and often carry the first signal.

> If Issues are empty but the page is broken, the frontend SDK may be disabled (no `EXPO_PUBLIC_SENTRY_DSN` in that deploy) — report that as a gap and fall back to bundle/Caddy evidence. Don't block on it.

### Step 5 — Sentry: backend Issues for failing API calls

The web app's `fetch` calls continue the same distributed trace into Fiber, so a broken page is often a 5xx on the Go side.

- `mcp__sentry__search_issues` against `golf-league-backend` — `query: "is:unresolved"`, `sort: "freq"`.
- For a specific failing request, take its `trace_id` from the frontend event and search `dataset: "errors"` / `dataset: "spans"` for the matching trace to see exactly which handler errored.

### Step 6 — Sentry: trace the failure

For a concrete reproduced error, run `mcp__sentry__analyze_issue_with_seer` on the issue (URL or `issueId`) to get root-cause analysis with file:line and a suggested fix. Only invoke Seer when you can't determine the cause from the issue detail alone.

### Step 7 — Performance pass (see "Performance investigation" below)

### Step 8 — Report findings

Summarise:
1. Bundle status: clean / how many `import.meta.*` found and from which packages
2. Caddy health: OK / not reachable
3. Sentry frontend: N open Issues / top error / SDK disabled
4. Sentry backend: N open Issues / which handlers 5xx
5. Performance: slowest spans/endpoints and any regression vs. baseline
6. **Root cause hypothesis** + specific file and line to fix (bug and/or perf)

---

## Mobile investigation

### Step 1 — Check for connected devices

```bash
adb devices
```

Lists `emulator-NNNN` (running emulator) or `XXXXXXXX` (physical device). If empty (only the header line), no device is connected.

### Step 2 — List available AVDs (if no device)

```bash
emulator -list-avds
```

Pick the first AVD and start it:

```bash
emulator -avd <avd-name> &
```

Wait ~30 seconds, then re-run `adb devices` to confirm the emulator appears.

### Step 3 — Start Expo dev server

```bash
export PATH="/c/Program Files/nodejs:/c/Users/trent/AppData/Roaming/npm:$PATH"
cd /c/Users/trent/git-repos/golf-league/mobile
npx expo start --android 2>&1 &
```

This opens the Expo Metro bundler and launches the app on the connected device/emulator. Watch the Metro output for bundling errors (red text, "error" keyword).

> `@sentry/react-native` ships native code and does **not** load in Expo Go — native crash reporting needs an EAS dev build (the `development` profile sets `developmentClient: true`). On Expo Go you'll only see Metro/logcat signals, not Sentry events.

### Step 4 — Tail device logs for JS errors

```bash
adb logcat -s ReactNativeJS:V ReactNative:V ExpoModules:V 2>&1 | head -100
```

Look for:
- `ERROR` level logs with stack traces
- `Unhandled promise rejection`
- `Warning:` messages that indicate a broken state
- Network errors (`Failed to fetch`, `Network request failed`)

### Step 5 — Check Metro bundler output

Metro prints errors directly to stdout. Common failures:
- `SyntaxError` in a specific file → Babel config issue or unsupported syntax
- `Unable to resolve module` → missing dependency or wrong import path
- `EMFILE: too many open files` → watchman not running; run `watchman watch-del-all`

### Step 6 — Sentry: mobile Issues, Logs, and the phantom-save filter

Local device logs only show the current session — Sentry has every user's. Against `golf-league-frontend`:

- `mcp__sentry__search_issues` — `query: "is:unresolved"`, `sort: "freq"` for the most-hit crashes; add `environment:production` or `environment:preview` to scope to a build channel.
- For the known **cellular phantom-save** bug, filter Issues by `mutation_error_kind:network` — the exception message is the exact transport error and breadcrumbs carry the request URL (see [mobile/docs/observability.md](../../../mobile/docs/observability.md)).
- `mcp__sentry__search_events` `dataset: "logs"` with the dotted `event:` facet for warning-level breadcrumbs that never became Issues.

### Step 7 — Performance pass (see "Performance investigation" below)

### Step 8 — Report findings

Summarise:
1. Device: emulator / physical / none found
2. Metro: bundled successfully / N errors
3. Device logs: N JS errors / clean
4. Sentry mobile: N open Issues / top crash / phantom-save hits
5. Performance: slowest screens/transactions and any regression
6. **Root cause hypothesis** + specific file and line to fix (bug and/or perf)

---

## Performance investigation

The SRE job isn't only broken things — it's slow things. Run this pass on every sweep (or standalone via `/sre perf`). The goal is to name the slowest real operations and the file:line that owns them, so a perf fix is as actionable as a bugfix.

### Backend — slowest spans and N+1 queries (`golf-league-backend`)

Use `mcp__sentry__search_events` with `dataset: "spans"`:

- **Slowest operations overall** — `sort: "-span.duration"`, `fields: ["span.op", "span.description", "span.duration", "transaction"]`, `statsPeriod: "24h"`. The top rows are your latency offenders.
- **Slowest HTTP handlers** — `query: "span.op:http.server"`, `sort: "-span.duration"`; or aggregate with `fields: ["transaction", "p95(span.duration)", "count()"]`, `sort: "-p95(span.duration)"` to rank endpoints by p95 rather than a single outlier.
- **Database hotspots / N+1** — `query: "span.op:db"`, `sort: "-span.duration"`, then group by `span.description`. Many near-identical short DB spans inside one transaction = an N+1; collapse it in the service layer (`internal/services/`), not the handler.

Backend CPU profiling isn't shipped yet (sentry-go has no stable `ProfilesSampleRate` — see [backend/docs/observability.md](../../../backend/docs/observability.md)), so reason about backend CPU from span timings, not profiles.

### Frontend — slow transactions and profiles (`golf-league-frontend`)

- **Slow screens / interactions** — `mcp__sentry__search_events` `dataset: "spans"`, `query: "span.op:navigation"` or `span.op:ui.load`, `sort: "-span.duration"`, to find which screens are slow to render/transition.
- **Slow network from the client** — `query: "span.op:http.client"`, `sort: "-span.duration"` — distinguishes "the API is slow" (matches a backend span on the same `trace_id`) from "the client is slow" (no matching slow backend span → render/JS cost).
- **CPU / wall-time** — `dataset: "profiles"` to find functions burning time on device/web. Pair with the extract-first rule: heavy logic belongs in a tested `utils/` pure function, which is also where you'd optimise it.

### Triage and report

For each finding, capture: operation/transaction name, p95 (or the outlier duration) and count, the owning file:line, and a one-line fix hypothesis (add an index, batch a query, memoise a render, defer work off the critical path). Rank by `p95 × count` — fix the expensive-and-frequent first, not the single slowest cold call.

---

## After investigation

Once a root cause (bug) or hotspot (perf) is identified, fix it inline (don't spawn a sub-agent for simple fixes). Then:
- For web: re-run step 2 of the web investigation to confirm the bundle is clean.
- For mobile: confirm the fix in the emulator/device logs.
- For a perf fix: re-query the relevant Sentry span/transaction after the change deploys to confirm the duration/p95 actually dropped — a perf fix isn't done until the number moves.
- Run `/ci` before declaring done if any logic was changed; ship tests in the same change per CLAUDE.md.
