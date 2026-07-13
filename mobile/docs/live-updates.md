# Live updates — polling, the poll gate, and the read path

How other players' scores reach a screen, and why there is no WebSocket.

---

## The short version

**Polling is the only live-update mechanism.** Every "live" view refetches on a **60s interval,
but only while the screen is focused and the app is foregrounded** (`LIVE_POLL_MS` in
[`constants/api.ts`](../constants/api.ts)). A phone in a pocket makes no requests.

On the scorecard, a polled snapshot is **not merged immediately**. It passes through the
[poll gate](#the-poll-gate) first, which holds it until the player stops interacting.

Every API call — read and write — goes through a hardened primitive. **Bare `fetch()` is a lint
error** in `app/`, `components/`, and `hooks/`.

---

## Why the WebSocket was removed

There *was* a live-score WebSocket (`scores_updated` → invalidate the scorecard query). It was
deleted, along with ~550 lines of reconnect machinery, because it caused far more harm than the
latency it saved. Two independent faults, and it took six commits and four failed field tests to
see them both:

**1. It echoed every save back to the device that made it.** The backend broadcast to *all*
clients in a round with no sender exclusion, so: pill tap → `PUT /hole-stats` → server echoes
`scores_updated` → the saving device's own socket receives it → `invalidateQueries` → refetch →
3-way merge `setState` → the ~1900-line scorecard re-renders. If that reflow landed between a
pill's `onPressIn` and its `onPress`, React Native dropped the press — the pill dimmed and
nothing happened. **This happened on healthy networks**, which is why memoizing the pill row,
throttling the reconnect catch-up, and debouncing taps only narrowed the window instead of
closing it.

**2. It never once connected on the league's cellular network.** A production retest logged
**421 disconnects, 0 opens, 0 give-ups**; the backend logged zero `ws.connected`. The `wss`
handshake died upstream of the Go server. On the one network that matters on a golf course, it
delivered *zero* live updates while generating a reconnect storm.

The 60s poll was its documented fallback floor — and, in practice, the thing doing all the real
work the entire time. Removing the socket didn't cost a feature; it removed a bug generator.

> **Backend tombstone.** `GET /api/v1/ws/rounds/:roundId` still exists and returns **410 Gone**
> ([`backend/internal/handlers/sunset.go`](../../backend/internal/handlers/sunset.go)). Builds
> already on players' phones still dial it; a definitive 410 lets their reconnect loop hit its
> give-up cap once and settle onto the 60s poll they always had, instead of storming. The handler
> emits a sampled `ws.sunset_hit` log — **when that goes quiet, delete the route and the handler.**

---

## Cadence

| Query | Where | Interval |
|---|---|---|
| `["scorecard", roundId]` | [`app/scorecard/[roundId].tsx`](../app/scorecard/[roundId].tsx) | 60s |
| `["round", id]` | [`app/rounds/[id].tsx`](../app/rounds/[id].tsx) | 60s |
| `["scorecard", id]` (leaderboard/stats tabs) | [`app/rounds/[id].tsx`](../app/rounds/[id].tsx) | 60s |
| `["event", id]`, `["event", id, "rounds"]`, per-round scorecards | [`app/events/[id].tsx`](../app/events/[id].tsx) | 60s |

All set `refetchIntervalInBackground: false`. Average hole takes ~13 minutes, so 60s catches a
peer's score well within a hole.

Two other things trigger a refetch, both in [`app/_layout.tsx`](../app/_layout.tsx):

- **App foreground** — `focusManager` is wired to `AppState`.
- **Network regained** — `onlineManager` is wired to **NetInfo**. This subscription used to belong
  to the WebSocket hook; it was re-homed rather than deleted. Before this, React Query's online
  detection leaned on browser signals that don't exist in React Native, so `refetchOnReconnect`
  never reliably fired and a player walking out of a dead spot had to pull-to-refresh by hand.

---

## The poll gate

[`utils/pollGate.ts`](../utils/pollGate.ts) — pure, unit-tested.

Merging a server snapshot re-renders and reflows the whole scorecard. Even at a 60s cadence, a
tick can land under the player's finger. Rather than shrink that window and hope, the gate closes
it:

```ts
shouldApplyPolledSnapshot({ inFlightSaves, msSinceLastInteraction, quietMs? }): boolean
```

A snapshot is applied **only when no save is on the wire AND the player has been quiet for
`POLL_QUIET_MS` (3s)**. Otherwise it is stashed in `pendingSnapshotRef` and applied the moment they
go idle (re-checked every `POLL_GATE_RECHECK_MS`). Nobody perceives the delay on a 60s cadence, and
**no tap can be swallowed again.**

The screen feeds the gate two refs — `lastInteractionAtRef` (bumped on every pill tap, keystroke,
and hole change) and `inFlightSavesRef` (incremented for the whole `savePut` lifetime, retries
included). The in-flight check protects correctness as well as the gesture: a snapshot merged
while a save is on the wire may not yet include that write.

The **degraded-snapshot guard** (`incomingSnapshotIsDegraded`) still runs, after the gate opens.

---

## The read path

[`utils/apiGet.ts`](../utils/apiGet.ts) is to reads what `savePut`/`savePost` are to writes.

```ts
apiGetJson<T>({ url, token, label })   // what every queryFn calls
apiGet({ url, token, profile, label, method?, body? })  // when you need the raw Response
```

- **Per-attempt `AbortController` timeout** — a GET stuck on a dead okhttp keep-alive socket fails
  fast instead of hanging forever; the retry opens a fresh connection.
- **Full-Jitter backoff** over transport failures ([`utils/withRetry.ts`](../utils/withRetry.ts)),
  the same curve the save path uses.
- **Only transport failures are retried.** A non-2xx is returned/thrown as-is: a 4xx won't heal,
  and a 5xx storm shouldn't be amplified by the client.
- **Telemetry** — a breadcrumb per failed attempt, and on exhaustion a `read.failed` report with an
  endpoint label and a lazy connection snapshot.

Profiles: `READ_GET` (screen reads + polls) and `RECONCILE_GET` (the phantom-save read-back, which
runs *after* a write already burned its budget, so it's kept short).

**Retry lives in exactly one layer.** `QueryClient` sets `retry: false`, because `apiGet` already
retries — leaving TanStack's default `retry: 3` on top would compound into nine attempts and a
multi-minute tail before a screen could even show an error.

**Read-shaped POST.** `POST /courses/search-external` is a query in everything but HTTP verb, so it
goes through `apiGet({ method: "POST", body })` — read telemetry, no Idempotency-Key.

### No bare fetch

Enforced by `no-restricted-syntax` in [`eslint.config.js`](../eslint.config.js) across `app/`,
`components/`, and `hooks/`. `utils/` is exempt — that's where the primitives live. There is exactly
one sanctioned exception, marked with an `eslint-disable`: reading a local `file://` URI into an
ArrayBuffer for the avatar upload (no network, nothing to retry).

This rule is the durable half of the change. Bare fetches had been hand-removed twice before
(`ff78640`, `457559c`) and crept straight back, because nothing enforced it.

---

## Save failures never block play

When a save exhausts every retry **and** the phantom-save reconcile can't confirm the write,
the scorecard shows [`components/SaveStatusBanner.tsx`](../components/SaveStatusBanner.tsx) —
an inline, non-blocking strip with a **Retry** action. It never covers the card and never
blocks input; scoring continues underneath it.

It replaced the modal `Alert`s (the "panic error"). A player standing on a tee box holding a phone
in one hand cannot be made to dismiss a dialog, and a transient cellular blip should not read as
data loss. The edit is still in local state and on screen, so the honest message is **"saved on
this phone, will sync"** — not "failed".

The one Alert left on the scorecard is input validation ("enter a valid course handicap"), which is
immediate feedback on the player's own typo, not a network panic.

---

## Observability

| Event | Channel | Means |
|---|---|---|
| `scorecard.refetch` `source:"poll"` | breadcrumb + sampled log | the poll is alive |
| `poll.deferred` | breadcrumb + sampled log | the gate held a snapshot — proves it works, bounds the delay |
| `read.failed` / `error_source:read` | warn log (4xx/transport), **Issue** on 5xx | a read exhausted its retries; tagged `read_endpoint` + connection |
| `upload.failed` / `error_source:upload` | Issue | avatar → Supabase Storage failed after retries |
| `scorecard.merge_skipped` | warn log | degraded snapshot rejected |
| `save.*` / `create.*` | Issues + logs | unchanged (see [network-saves.md](network-saves.md)) |
| `ws.sunset_hit` | sampled backend log | an old build still dialing the dead socket |

A failed read reports itself **once**: `apiGet` files it (with the label and connection snapshot
the generic handler couldn't reconstruct) and marks the `ApiError` as `reported`, which
`reportQueryError` checks so the QueryCache handler doesn't file a duplicate.
