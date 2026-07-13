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
   keep-alive socket fails fast so the *next* retry opens a fresh connection. The old raw saves
   had none, and a bare `fetch` can hang indefinitely.
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

## Every call goes through a helper — bare `fetch` is a lint error

The chokepoint isn't just for scorecard `PUT`s. **Every state-mutating request in the app**
routes through `savePut` (idempotent `PUT`/`PATCH`/`DELETE`) or `savePost`
([`utils/savePost.ts`](../utils/savePost.ts), non-idempotent `POST` creates). This closed the
remaining raw sites — round end/reactivate/edit/delete, group + member + team deletes, event
edit/cancel/delete/role/join-request, course create/edit/delete/refresh, tee + hole authoring,
request-join, and follow/unfollow.

**Reads have the same contract now.** They go through `apiGetJson`/`apiGet`
([`utils/apiGet.ts`](../utils/apiGet.ts)) — same timeout, same Full-Jitter retry, same telemetry.
A `no-restricted-syntax` ESLint rule makes a bare `fetch()` an **error** in `app/`, `components/`,
and `hooks/`, because hand-removing them twice (`ff78640`, `457559c`) didn't stop them coming back.
See [`live-updates.md`](live-updates.md#the-read-path).

- **`savePut` method** is `PUT` (default), `PATCH`, or `DELETE`. `DELETE` is idempotent and
  **404-tolerant**: a 404 on a retry means the row is already gone (a phantom delete whose ack
  was lost, or a double-tap) — the goal state — so the core treats it as success. Pass
  `body: undefined` on a `DELETE`.
- **`parseErrorMessage: readApiErrorMessage`** on a user-facing idempotent mutation surfaces the
  API's `{ error }` (e.g. "course is referenced by a round") instead of a generic
  `Save failed: HTTP 409`. Background scorecard saves omit it (their failures are telemetry).
- **`savePost`** parses the created row's JSON (id needed to navigate) but tolerates an empty
  `204` body (follow, request-join) by resolving `undefined`.
- **Follow/unfollow** shares one helper, [`utils/follow.ts`](../utils/follow.ts): unfollow →
  `savePut(DELETE)`, follow → `savePost` (its route is durable-idempotency wrapped).
- **Retrying a non-idempotent create is only safe where the backend dedupes it.** `savePost`'s
  retry replays the original response via the durable `Idempotency-Key` store
  ([`backend/internal/middleware/idempotency.go`](../../backend/internal/middleware/idempotency.go)).
  Phase 2 wrapped the remaining create routes with `durableIdempotency` — `request-join`,
  `POST /courses`, `POST /courses/:id/tees`, `import-external`, and `follow` — since each returns
  an "already exists" error on a blind duplicate. Never route a create through `savePost` unless
  its route is wrapped (or the handler is naturally idempotent).

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

> **The read-back must itself be resilient — never a bare `fetch()`.** The reconcile GET runs
> on the *same* degraded cellular that just exhausted the write's retries, so a single
> unprotected `fetch()` usually fails too and the phantom can't be confirmed — a false
> "failed to save"/"Stats failed to save" even though the data is safe (Sentry 7/8: 11
> read-backs confirmed, but the one that also lost the GET surfaced the false error). Both
> scorecard reconciles therefore read through **[`apiGet`](../utils/apiGet.ts)** (the read
> counterpart to `savePut`/`savePost`): a per-attempt `AbortController` timeout + Full-Jitter
> retry over transport failures (`RECONCILE_GET` profile), returning the `Response` for any
> HTTP status (a non-2xx is returned, not retried — it won't heal). Any authenticated read
> that must survive a flaky link should use `apiGet`, not a raw `fetch()`.

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
`create_kind`, `create_outcome:reconciled`) so creates filter apart from saves.

### Create-side phantom recovery — `recoverUrl` / `GET /idempotency/:key`

The backend replay only helps when *some* attempt's ack survives. On a badly degraded cell
link **every** attempt in the 3-try/~36 s budget can lose its ack while the row commits — the
7/7 "network error, but the round was created" report. The dedupe still prevents a duplicate,
but `savePost` throws and the screen alerts even though the row exists.

`savePost` closes this with an optional **`recoverUrl(idempotencyKey) => string`**. On
*transport* exhaustion (never an HTTP non-2xx — that's a real rejection), `saveWithRetry`
calls the built-in `recoverByKey` with the stable key it already holds; `recoverByKey` does a
`GET /api/v1/idempotency/:key`, which **replays the committed create response for that exact
key** (deterministic, no fuzzy matching, works for every create type). A 200 resolves the new
row (so the screen navigates and `reportCreateReconciled` fires); a 404 (not committed /
expired / foreign) falls through to the normal failure path. Round-create passes
`recoverUrl: (key) => `${API_URL}/api/v1/idempotency/${key}``; backend handler is
`handlers.LookupIdempotentResponse` over `DurableIdempotencyStore.Lookup`.

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
