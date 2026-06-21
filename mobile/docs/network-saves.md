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
phantom save via `reportSaveReconciled` — a `save_outcome:reconciled` **structured Sentry log**
(not a `captureMessage`, so it never opens an Issue) that is the client-side phantom-save
**counter**. A `reconcile` that returns false or throws falls through to the normal
`reportSaveFailure` + rethrow; its own failure never masks the original error.

Server side, the `Idempotency-Key` lets the backend log `score.idempotent_replay` when a retry
lands on an already-committed save (`backend/internal/middleware/idempotency.go`) — the
server-side half of the same counter. To chart phantom saves: `save_outcome:reconciled` (client,
recovered) vs `save_kind:network` `reportSaveFailure` (client, genuinely unrecovered) vs the
backend replay log.

## POST creates go through `savePost`

Non-idempotent `POST` creates (event, round, group, member, guest, team) have the same
cellular phantom failure mode — the row commits but the ack is lost, the client shows
"Could not create …", and a *blind* retry would create a duplicate. They now go through
[`savePost`](../utils/savePost.ts), the POST counterpart to `savePut`. Both are thin
adapters over the shared core [`saveWithRetry.ts`](../utils/saveWithRetry.ts), which owns
the timeout + Full-Jitter backoff + stable `Idempotency-Key` + connection snapshot +
telemetry once for both verbs.

```ts
import { savePost } from "@/utils/savePost";

const round = await savePost<{ id: string }>({
  url: `${API_URL}/api/v1/rounds`,
  token: token ?? "",
  body: payload,
  label: "round",          // becomes create_endpoint in Sentry
});
router.replace(`/rounds/${round.id}`); // savePost returns the parsed body (the new id)
```

What makes a retry safe is the **durable** backend store: the client sends one stable
`Idempotency-Key` per logical create, and `middleware.Idempotency`
(`backend/internal/middleware/idempotency.go`, table `idempotency_keys`, migration
000024) **replays the original response** on a repeat instead of creating a second row.
So the first surviving ack returns the new row's id with no duplicate. This is why
`savePost` resolves the parsed body (creates need the id to navigate) while `savePut`
resolves void.

Differences from `savePut`: `CREATE_SAVE` profile (3 attempts, 4 s cap, 12 s timeout —
creates are foreground); a `parseErrorMessage` hook surfaces the API's `{ error }` text on
a non-2xx instead of a bare status; telemetry is `error_source:create` (`create_endpoint`,
`create_kind`, `create_outcome:reconciled`) so creates filter apart from saves. A
`reconcile` callback exists for the rare case where *every* attempt's ack is lost, but the
pilot ships without one and relies on the backend replay.

**Coverage:** every non-idempotent create is wired — `POST /events`, `POST /rounds`,
`POST /events/:id/rounds`, `POST /events/:id/members`, `POST /rounds/:id/groups`,
`POST .../groups/:gid/members`, `POST .../groups/:gid/guests`, `POST /rounds/:id/teams` —
each behind `middleware.Idempotency` on the backend and `savePost` on the client.

## Idempotent PATCH/PUT mutations also use `savePut`

Mutations that converge to the same state on repeat — **not** just PUT — route through
`savePut` too, since they're safe to retry with a stable key. `savePut` takes an optional
`method` (default `PUT`, accepts `PATCH`) so these reuse the one chokepoint:

- **Start round** — `PATCH /rounds/:id {status:"active"}` (`app/rounds/[id].tsx`). Setting
  the same status twice converges, so it retries like a save. Its `reconcile` reads the
  round back and calls `roundStatusReconciled` ([`utils/roundReconcile.ts`](../utils/roundReconcile.ts),
  pure + tested) — an already-`active` status suppresses the false "couldn't start round."
- **Assign team members** — `PUT /rounds/:id/teams/:teamId/members` (team modals). The
  backend replaces the team's membership atomically (delete-all + insert-set), so a repeat
  is a no-op. The team flow is compound: `savePost` the team create, then `savePut` the
  membership. Backend-side these idempotent routes carry the lightweight in-memory
  `replayLog` (detection only — no second row is possible), like the scores/hole-stats PUTs.
