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
  maxAttempts: 8, // after this many failed reconnects, give up and lean on the 60s poll
} as const;

// Idle watchdog window. The server pings every 30s, so 60s of total silence means the
// socket is half-open (the cellular last-mile case) and should be recycled even though
// no error/close event fired.
export const WS_IDLE_MS = 60_000;

// buildWsUrl converts the HTTP API base into a ws(s):// subscription URL for one round.
// The JWT rides in ?token= because a browser can't set an Authorization header on a WS
// upgrade. https→wss and http→ws; an already-ws(s) base is passed through.
export function buildWsUrl(apiUrl: string, roundId: string, token: string): string {
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
  // Trim trailing slashes without a regex (a `\/+$` pattern trips ReDoS scanners) so the
  // path isn't doubled.
  let host = rest;
  while (host.endsWith("/")) host = host.slice(0, -1);
  return `${scheme}://${host}/api/v1/ws/rounds/${roundId}?token=${encodeURIComponent(token)}`;
}

// nextReconnectDelay returns the ms to wait before reconnect attempt `attempt`
// (zero-based: 0 = the wait after the first disconnect). rng is injectable for tests.
export function nextReconnectDelay(
  attempt: number,
  rng: () => number = Math.random,
): number {
  return fullJitterDelay(
    attempt,
    { baseMs: WS_RECONNECT.baseMs, capMs: WS_RECONNECT.capMs },
    rng,
  );
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

// LiveAction is the decoded intent of a server message. Only "scores_updated" matters
// today; anything else is "unknown" and ignored (forward-compatible).
export type LiveAction =
  | { type: "scores_updated"; roundId?: string }
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
