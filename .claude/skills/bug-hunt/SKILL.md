---
name: bug-hunt
description: Investigate a broken web app or mobile app. For web: fetch the live URL, grep the JS bundle for known failure patterns (import.meta, SyntaxError sources), and query Grafana (Loki for errors, Tempo for failed traces). For mobile: check ADB for connected devices/emulators, optionally start one, launch Expo dev server, and tail Metro/device logs for errors.
---

# bug-hunt

Investigate a reported bug end-to-end before fixing it. The skill surfaces root causes; Claude then fixes them.

## Invocation

```
/bug-hunt          — investigate both web and mobile
/bug-hunt web      — web only
/bug-hunt mobile   — mobile only
```

If no argument is given, check web first, then mobile.

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

### Step 4 — Check Grafana: Loki for web errors

Query Loki for the web container's recent error logs. Use `mcp__grafana__query_loki_logs` with:
- `query`: `{service="golf-web"}` or `{container="web"}` — adjust label to match what Railway ships
- `since`: `1h` or `now-30m`
- Look for JavaScript errors, Caddy panics, or OOM signals

> **Note:** If Loki returns zero results, the web container has no log shipper. Check with `mcp__grafana__list_loki_label_names` to see what labels exist — if `service` or `container` labels for the web app are absent, log shipping isn't configured. Report this as a separate gap; don't block on it.

Use `mcp__grafana__find_error_pattern_logs` with the backend service label to check for backend-side 4xx/5xx that the web app's API calls might be hitting.

### Step 5 — Check Grafana: Tempo for failed traces

Use `mcp__grafana__tempo_traceql_search` (or `mcp__grafana__find_slow_requests`) to look for:
- Traces with `status = error`
- High-latency API calls from the web session (look for `X-Correlation-ID` header spans)
- Backend handler spans that errored in the last 30 minutes

### Step 6 — Report findings

Summarise:
1. Bundle status: clean / how many `import.meta.*` found and from which packages
2. Caddy health: OK / not reachable
3. Loki: N errors in last 1h / no log shipper configured
4. Tempo: N failed traces / clean
5. **Root cause hypothesis** + specific file and line to fix

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

### Step 6 — Report findings

Summarise:
1. Device: emulator / physical / none found
2. Metro: bundled successfully / N errors
3. Device logs: N JS errors / clean
4. **Root cause hypothesis** + specific file and line to fix

---

## After investigation

Once root cause is identified, fix it inline (don't spawn a sub-agent for simple fixes). Then:
- For web: verify the bundle is clean with step 2 of the web investigation after fixing
- For mobile: confirm the fix in the emulator/device logs
- Run `/coverage` before declaring done if any logic was changed
