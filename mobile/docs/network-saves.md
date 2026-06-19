# Network Saves — `savePut`, Backoff, and Observability

Scorecard saves run on a Wednesday-league cellular link where a write can commit
server-side while the response is lost on the last-mile hop — fetch then rejects and the
client shows a **false "failed to save."** The backend and Railway edge were exonerated
(100% 2xx, no deploy/restart in the investigation window); the loss is between Railway's
edge and the phone. See the project memory `project-cellular-phantom-saves` and
`project-retry-idempotent-saves`.

This doc is the contract for how saves go out. The data source for diagnosing recurrences
is the client-side Sentry save report (connection type, attempts, elapsed, HTTP status).

## The rule: idempotent saves go through `savePut`

Every idempotent save (a `PUT` that overwrites server state — scores, hole-stats, course
handicap) MUST go through [`savePut`](../utils/saveRequest.ts). Do not call `fetch` directly
from a screen for a save. `savePut` is the single instrumented chokepoint, so all saves get,
uniformly:

1. **A bounded per-attempt timeout** (`AbortController`). A request stuck on a dead okhttp
   keep-alive socket fails fast so the *next* retry opens a fresh connection. `utils/api.ts`
   (`apiFetch`) has no timeout, and the old raw saves had none.
2. **Capped exponential backoff with Full Jitter** (via [`withRetry`](../utils/withRetry.ts)).
3. **A throw on `!res.ok`**, so HTTP errors are retried and surfaced (this fixed the
   `handleSaveHandicaps` silent-success-on-5xx bug, where a raw fetch never checked the status).
4. **Telemetry on exhaustion** (`reportSaveFailure`) plus a breadcrumb per failed attempt. The
   raw saves bypassed `reportMutationError` and emitted no Sentry event — which is why the
   phantom-save failures left no Issue.
5. **A stable `Idempotency-Key`** (a v4 UUID from [`utils/idempotency.ts`](../utils/idempotency.ts)),
   minted once per logical save and reused on every internal retry. The backend uses it to count
   replays — see *Phantom-save reconciliation* below.

```ts
import { savePut, BACKGROUND_SAVE, FOREGROUND_SAVE } from "@/utils/saveRequest";

await savePut({
  url:   `${API_URL}/api/v1/rounds/${roundId}/players/${roundPlayerId}/scores`,
  token: token ?? "",            // getToken() can be null; savePut wants a string
  body:  { scores: entries },
  label: "scores",               // becomes save_endpoint in Sentry
  retry: BACKGROUND_SAVE,
});
// On exhaustion savePut reports the failure and rethrows, so the caller's existing
// try/catch still sets its UI error flag.
```

## Retry profiles (documented, not arbitrary)

Per the AWS Architecture Blog *Exponential Backoff And Jitter* and the FreeRTOS/AWS-IoT
`backoffAlgorithm` (built for "environments with poor connectivity"), the recommended
approach is **capped exponential backoff with Full Jitter**:

```
delay = random(0, min(cap, base * 2^attempt))
```

Full Jitter is the variant AWS measured as best: it spreads attempts widely, decorrelating
the retry from the network's own congestion/recovery cycle and **varying connection timing so
okhttp evicts the stale pooled socket and opens a fresh one** — the actual fix for our failure
mode. Fixed-delay retries (the old `[500,1000,2000]`) fired inside ~3.5 s and reused the same
poisoned connection, so every attempt failed identically. `Math.random` is sufficient for the
jitter (single client; the fleet-coordination rationale doesn't apply, but the
connection-turnover benefit does).

Two presets in [`utils/saveRequest.ts`](../utils/saveRequest.ts), tunable named constants:

| Profile | Used by | maxAttempts | baseMs | capMs | per-attempt timeout |
|---|---|---|---|---|---|
| `BACKGROUND_SAVE` | scores, hole-stats (invisible, optimistic) | 5 | 500 | 8000 | 15000 |
| `FOREGROUND_SAVE` | handicap saves (visible spinner) | 3 | 500 | 4000 | 12000 |

Background saves are invisible and optimistic, so a longer total budget maximizes *silent*
success (fewer false errors). Handicap saves show an `ActivityIndicator` and disable the
button, so a shorter budget avoids a minute-long spinner; the user can re-tap. The **15 s
per-attempt timeout is deliberately generous** — real saves complete <1 s (Railway edge
p99 ≤731 ms), so it never cuts off a working-but-slow request; it only bounds a *hung* socket.

## Observability

On exhaustion `savePut` calls `reportSaveFailure` (in [`utils/sentry.ts`](../utils/sentry.ts)),
which captures a Sentry Issue tagged `error_source:save`, `save_kind:network|http`,
`save_endpoint:<label>`, `connection_type:<type>`, with `extra` carrying `attempts`,
`elapsedMs`, `httpStatus`, `cellularGeneration`, `isInternetReachable`. The connection snapshot
is read **lazily on failure only** (NetInfo), so the happy path pays nothing; a NetInfo error
degrades to `connection_type:"unknown"` and never masks the save error. Each failed attempt
also drops a `category:"save"` breadcrumb (warning while retries remain, error on the final
attempt). To triage a recurrence, filter Sentry (golf-league-frontend) by `error_source:save`.

## Phantom-save reconciliation (the deeper fix)

Retry/backoff alone cannot fix a *lost response*: if the write committed and only the ack was
dropped, every retry re-commits the same idempotent upsert and still never sees a 2xx, so the
client shows a false failure. (Confirmed live: the save-hardening build still surfaced
`mutation_error_kind:network` failures during league play.)

So `savePut` takes an optional **`reconcile`** callback, invoked only after every retry has
failed **and only for a transport error** (no `httpStatus` — a real 5xx means the server
rejected the write and must surface). The scorecard screen's `reconcile` reads the scorecard
back and compares the server's scores to what we tried to write
([`utils/saveReconcile.ts`](../utils/saveReconcile.ts), pure + tested). If they already match,
the write truly landed: `savePut` resolves normally (no error flag) and records the recovered
phantom save via `reportSaveReconciled` — a `save_outcome:reconciled` info message that is the
client-side phantom-save **counter**. A `reconcile` that returns false or throws falls through
to the normal `reportSaveFailure` + rethrow; its own failure never masks the original error.

Server side, the `Idempotency-Key` lets the backend log `score.idempotent_replay` when a retry
lands on an already-committed save (`backend/internal/middleware/idempotency.go`) — the
server-side half of the same counter. To chart phantom saves: `save_outcome:reconciled` (client,
recovered) vs `save_kind:network` `reportSaveFailure` (client, genuinely unrecovered) vs the
backend replay log.

## Deferred — POST creates

`savePut` is for **idempotent** verbs only. A blind retry of a non-idempotent `POST` create
could duplicate a row when the first response was merely lost. The `Idempotency-Key` header now
ships on saves, but the backend's replay handling is **detection/logging only** (the PUT targets
are idempotent upserts). Routing a create through a retrying save still needs a **durable**
server-side dedupe store that records the key and returns the original result on replay — the
in-memory replay detector is not sufficient for that. Still **deferred**.
