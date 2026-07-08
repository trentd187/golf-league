// utils/liveUpdates.ts
// Pure helpers for the round live-update WebSocket (driven by hooks/useRoundLiveUpdates).
//
// The WebSocket is a *latency enhancement only*: it pushes a tiny "scores_updated"
// message so the scorecard refetches near-instantly instead of waiting on its 60s
// poll. Every reconnect/disconnect *decision* lives here as a pure function so it's
// unit-tested (the hook itself is a coverage-excluded thin shell). The 60s poll stays
// as the floor, so when these helpers decide to give up the app simply degrades to
// today's behavior. See backend/docs/websockets.md.

import { fullJitterDelay } from "@/utils/withRetry";

// Reconnect curve + give-up cap. Capped exponential Full Jitter (same rationale as the
// save retry path) so reconnect storms on a recovering cell network are decorrelated.
export const WS_RECONNECT = {
  baseMs: 1_000,
  capMs: 30_000,
  // floorMs: full jitter alone is random(0, ceiling) — no lower bound — so early attempts
  // can fire back-to-back. On a socket that opens then immediately closes (the web/Safari
  // case, worsened by a briefly-unreachable backend) that is a reconnect storm; the floor
  // guarantees a minimum spacing between attempts (the 7/3 session logged 50 disconnects/20m).
  floorMs: 1_000,
  // minStableMs: a connection must hold at least this long before its open is treated as a
  // real success that resets the attempt counter. Without this, a flapping socket resets to
  // attempt 0 on every brief open and NEVER reaches maxAttempts — an unbounded storm.
  minStableMs: 10_000,
  // gaveUpCooldownMs: after giving up (maxAttempts failed → poll fallback), a foreground or
  // network-regained event must not immediately restart a full storm. Wait this long first.
  gaveUpCooldownMs: 60_000,
  maxAttempts: 8, // after this many failed reconnects, give up and lean on the 60s poll
} as const;

// Idle watchdog window. The server pings every 30s, so 60s of total silence means the
// socket is half-open (the cellular last-mile case) and should be recycled even though
// no error/close event fired.
export const WS_IDLE_MS = 60_000;

// WS_CATCHUP_MIN_MS throttles the onopen catch-up refetch. A cellular socket that reconnects
// ~1×/s (the 7/7 storm) would otherwise invalidate the scorecard query every second, and each
// refetch fires the 3-way merge's setState → the huge scorecard reflows mid-tap and cancels
// pill presses. A flap that reconnects inside this window can't have missed a peer update the
// 60s poll won't also catch, so we skip the catch-up. A real reconnect after a longer gap
// still syncs instantly.
export const WS_CATCHUP_MIN_MS = 10_000;

// buildWsUrl converts the HTTP API base into a ws(s):// subscription URL for one round.
// The JWT rides in ?token= because a browser can't set an Authorization header on a WS
// upgrade. https→wss and http→ws; an already-ws(s) base is passed through.
//
// pageProtocol (web only) is the hosting page's location.protocol. A browser blocks a
// ws:// connection from an https page (mixed content), so on web the socket scheme must
// follow the *page*, not the API base — which may be http:// behind a TLS-terminating
// proxy like Railway. Omit it on native, where there is no page protocol.
export function buildWsUrl(
  apiUrl: string,
  roundId: string,
  token: string,
  pageProtocol?: string,
): string {
  let scheme = "ws";
  let rest = apiUrl;
  if (apiUrl.startsWith("https://")) {
    scheme = "wss";
    rest = apiUrl.slice("https://".length);
  } else if (apiUrl.startsWith("http://")) {
    rest = apiUrl.slice("http://".length);
  } else if (apiUrl.startsWith("wss://")) {
    scheme = "wss";
    rest = apiUrl.slice("wss://".length);
  } else if (apiUrl.startsWith("ws://")) {
    rest = apiUrl.slice("ws://".length);
  }
  // Force wss when the hosting page is https — the browser would otherwise reject a ws://
  // upgrade as insecure. Only ever upgrades the scheme, never downgrades it.
  if (pageProtocol === "https:") scheme = "wss";
  // Trim trailing slashes without a regex (a `\/+$` pattern trips ReDoS scanners) so the
  // path isn't doubled.
  let host = rest;
  while (host.endsWith("/")) host = host.slice(0, -1);
  return `${scheme}://${host}/api/v1/ws/rounds/${roundId}?token=${encodeURIComponent(token)}`;
}

// nextReconnectDelay returns the ms to wait before reconnect attempt `attempt`
// (zero-based: 0 = the wait after the first disconnect). Full-Jitter with a floor so a
// flapping socket can't reconnect faster than floorMs. rng is injectable for tests.
export function nextReconnectDelay(
  attempt: number,
  rng: () => number = Math.random,
): number {
  const jittered = fullJitterDelay(
    attempt,
    { baseMs: WS_RECONNECT.baseMs, capMs: WS_RECONNECT.capMs },
    rng,
  );
  return Math.max(WS_RECONNECT.floorMs, jittered);
}

// connectionWasStable reports whether a connection that stayed open for openMs held long
// enough to count as a real success — the gate for resetting the reconnect-attempt counter.
// A socket that opens then closes within minStableMs never truly connected, so resetting on
// its open would pin the storm at attempt 0 forever (never reaching the give-up cap).
export function connectionWasStable(
  openMs: number,
  minStableMs: number = WS_RECONNECT.minStableMs,
): boolean {
  return openMs >= minStableMs;
}

// shouldAttemptAfterGaveUp gates a reconnect triggered by a foreground/network-regained
// event after the hook already gave up: it must wait out a cooldown so those events can't
// immediately restart a full storm. A null lastGaveUpAt means we haven't given up — allow it.
export function shouldAttemptAfterGaveUp(
  lastGaveUpAt: number | null,
  now: number,
  cooldownMs: number = WS_RECONNECT.gaveUpCooldownMs,
): boolean {
  if (lastGaveUpAt === null) return true;
  return now - lastGaveUpAt >= cooldownMs;
}

// shouldResetAttemptsOnReconnect decides whether an EXTERNAL reconnect trigger (network
// regained / app foregrounded) may reset the attempt counter to 0. It may do so ONLY when
// recovering from a give-up past the cooldown. This is the fix for the unbounded 7/7 storm:
// the old handlers reset attemptRef=0 on every NetInfo `isConnected` event, and a flaky
// cellular radio fires those constantly — so the counter never climbed to maxAttempts, the
// give-up cap never engaged (`ws.gave_up` fired 0× despite 50 disconnects/min), and the
// reconnect loop ran forever. Mid-climb (not yet given up) an external trigger must NOT
// reset the counter — the onclose→scheduleReconnect loop already owns reconnection and must
// be allowed to reach the cap.
export function shouldResetAttemptsOnReconnect(
  gaveUp: boolean,
  lastGaveUpAt: number | null,
  now: number,
  cooldownMs: number = WS_RECONNECT.gaveUpCooldownMs,
): boolean {
  return gaveUp && shouldAttemptAfterGaveUp(lastGaveUpAt, now, cooldownMs);
}

// shouldResetAttemptsAfterClose decides whether a socket's onclose should reset the
// reconnect-attempt counter to 0. It resets ONLY when THIS socket actually opened
// (openedAt > 0) and then held at least minStableMs. The openedAt <= 0 guard is the 7/8
// cellular fix: when the wss handshake never completes, onopen never runs and openedAt keeps
// its 0 sentinel — so `now - 0` is an epoch-sized "openMs" that connectionWasStable would
// wrongly treat as a long stable connection, resetting the counter on EVERY failed handshake.
// That pinned attemptRef at 0, so maxAttempts (→ ws.gave_up → 60s-poll fallback) was never
// reached and the reconnect loop ran unbounded (one session: 421 disconnects, 0 opens, 0
// give-ups). The caller must clear openedAt to 0 before each connect so a failed attempt reads
// the sentinel rather than a prior stable socket's open time.
export function shouldResetAttemptsAfterClose(
  openedAt: number,
  now: number,
  minStableMs: number = WS_RECONNECT.minStableMs,
): boolean {
  if (openedAt <= 0) return false; // handshake never opened → a failure, not a stable success
  return connectionWasStable(now - openedAt, minStableMs);
}

// shouldCatchUpOnReconnect throttles the onopen catch-up refetch to at most once per
// WS_CATCHUP_MIN_MS. lastCatchUpAt is when we last invalidated the scorecard for a WS
// reconnect (null = never). Returns true on the first connect (nothing to throttle) and
// after the window elapses; false for a rapid flap (which the 60s poll already covers).
export function shouldCatchUpOnReconnect(
  lastCatchUpAt: number | null,
  now: number,
  minMs: number = WS_CATCHUP_MIN_MS,
): boolean {
  if (lastCatchUpAt === null) return true;
  return now - lastCatchUpAt >= minMs;
}

// shouldSampleDisconnect decides whether to LOG a given disconnect. The log fired once per
// close, which flooded Sentry Logs during a storm (50 in one 20-minute session). Keep the
// first `keepFirst` (so the onset is visible) and then every `everyNth`, so a persistent
// storm stays observable without drowning the timeline. count is 1-based per session.
export function shouldSampleDisconnect(
  count: number,
  keepFirst = 3,
  everyNth = 10,
): boolean {
  if (count <= keepFirst) return true;
  return count % everyNth === 0;
}

// ShouldReconnectParams: the state that decides whether to try reconnecting.
export interface ShouldReconnectParams {
  attempt: number; // reconnect attempts already made
  unmounted: boolean; // the screen/hook tore down — stop
  hasToken: boolean; // no auth token → can't connect
  maxAttempts?: number;
}

// shouldReconnect decides whether to schedule another reconnect. Returns false once the
// hook unmounted, the token is gone, or the attempt cap is hit (then the caller reports
// ws.gave_up and falls back to the poll).
export function shouldReconnect(params: ShouldReconnectParams): boolean {
  const max = params.maxAttempts ?? WS_RECONNECT.maxAttempts;
  if (params.unmounted) return false;
  if (!params.hasToken) return false;
  return params.attempt < max;
}

// LiveAction is the decoded intent of a server message.
//   "scores_updated" → refetch the scorecard.
//   "ping"           → the server's app-level heartbeat (see conn.go wsHeartbeat); a
//                      no-op for invalidation, but it still bumps the client's idle
//                      watchdog (the hook stamps lastMessageAt on every frame).
//   anything else    → "unknown" and ignored (forward-compatible).
export type LiveAction =
  | { type: "scores_updated"; roundId?: string }
  | { type: "ping" }
  | { type: "unknown" };

// parseLiveMessage decodes a raw socket payload into a LiveAction. Malformed JSON or an
// unrecognized type yields { type: "unknown" } rather than throwing — a bad frame must
// never crash the socket handler.
export function parseLiveMessage(raw: string): LiveAction {
  try {
    const data = JSON.parse(raw) as { type?: string; round_id?: string };
    if (data?.type === "scores_updated") {
      return { type: "scores_updated", roundId: data.round_id };
    }
    if (data?.type === "ping") {
      return { type: "ping" };
    }
  } catch {
    // fall through to unknown
  }
  return { type: "unknown" };
}

// isStaleConnection reports whether the socket has been silent past the idle window —
// the watchdog signal to recycle a half-open connection.
export function isStaleConnection(
  lastMessageAt: number,
  now: number,
  idleMs: number = WS_IDLE_MS,
): boolean {
  return now - lastMessageAt >= idleMs;
}
