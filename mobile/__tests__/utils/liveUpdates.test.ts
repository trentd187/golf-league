// __tests__/utils/liveUpdates.test.ts
// Unit tests for the pure live-update WebSocket helpers. The hook that consumes them
// (hooks/useRoundLiveUpdates) is a coverage-excluded thin shell, so these helpers carry
// all the reconnect/disconnect decision logic — and the tests.

import {
  buildWsUrl,
  nextReconnectDelay,
  shouldReconnect,
  parseLiveMessage,
  isStaleConnection,
  connectionWasStable,
  shouldAttemptAfterGaveUp,
  shouldSampleDisconnect,
  WS_RECONNECT,
  WS_IDLE_MS,
} from "@/utils/liveUpdates";

describe("buildWsUrl", () => {
  it("maps https → wss and appends the round path + token query", () => {
    expect(buildWsUrl("https://api.example.com", "round-1", "tok")).toBe(
      "wss://api.example.com/api/v1/ws/rounds/round-1?token=tok",
    );
  });

  it("maps http → ws", () => {
    expect(buildWsUrl("http://localhost:8080", "r2", "t")).toBe(
      "ws://localhost:8080/api/v1/ws/rounds/r2?token=t",
    );
  });

  it("passes through an already-ws(s) base", () => {
    expect(buildWsUrl("wss://api.example.com", "r", "t")).toBe(
      "wss://api.example.com/api/v1/ws/rounds/r?token=t",
    );
  });

  it("trims a trailing slash so the path isn't doubled", () => {
    expect(buildWsUrl("https://api.example.com/", "r", "t")).toBe(
      "wss://api.example.com/api/v1/ws/rounds/r?token=t",
    );
  });

  it("url-encodes the token", () => {
    expect(buildWsUrl("https://x", "r", "a b/c+d")).toContain(
      "token=a%20b%2Fc%2Bd",
    );
  });

  // Web mixed-content rule: a browser rejects ws:// from an https page. When the hosting
  // page is https the scheme must be wss even if the API base is http:// (the live web bug
  // — EXPO_PUBLIC_API_URL was an http:// base behind Railway's TLS-terminating proxy).
  it("forces wss when the page is https even with an http:// base", () => {
    expect(buildWsUrl("http://api.example.com", "r", "t", "https:")).toBe(
      "wss://api.example.com/api/v1/ws/rounds/r?token=t",
    );
  });

  it("stays wss when the page is https and the base is already https", () => {
    expect(buildWsUrl("https://api.example.com", "r", "t", "https:")).toBe(
      "wss://api.example.com/api/v1/ws/rounds/r?token=t",
    );
  });

  it("keeps ws for an http:// base when the page is http (local web dev)", () => {
    expect(buildWsUrl("http://localhost:8080", "r", "t", "http:")).toBe(
      "ws://localhost:8080/api/v1/ws/rounds/r?token=t",
    );
  });

  it("ignores the page protocol on native (undefined) — base scheme wins", () => {
    expect(buildWsUrl("http://localhost:8080", "r", "t", undefined)).toBe(
      "ws://localhost:8080/api/v1/ws/rounds/r?token=t",
    );
  });
});

describe("nextReconnectDelay", () => {
  it("grows the ceiling exponentially and stays within the cap (rng≈1 → near ceiling)", () => {
    // At attempt 3 the ceiling (8000) far exceeds the floor, so jitter is visible and grows.
    const d3 = nextReconnectDelay(3, () => 0.999999);
    const d1 = nextReconnectDelay(1, () => 0.999999);
    expect(d3).toBeGreaterThan(d1);
    expect(d3).toBeLessThanOrEqual(WS_RECONNECT.capMs);
  });

  it("never exceeds the cap even at high attempts", () => {
    expect(nextReconnectDelay(20, () => 0.999999)).toBeLessThanOrEqual(
      WS_RECONNECT.capMs,
    );
  });

  it("floors at floorMs even when rng is 0 (no back-to-back reconnect storm)", () => {
    // Pure full jitter would return 0 here; the floor keeps a minimum spacing.
    expect(nextReconnectDelay(5, () => 0)).toBe(WS_RECONNECT.floorMs);
    expect(nextReconnectDelay(0, () => 0)).toBe(WS_RECONNECT.floorMs);
  });
});

describe("connectionWasStable", () => {
  it("is false for a brief open (a flap that must not reset the attempt counter)", () => {
    expect(connectionWasStable(500)).toBe(false);
    expect(connectionWasStable(WS_RECONNECT.minStableMs - 1)).toBe(false);
  });

  it("is true once the connection held at least minStableMs", () => {
    expect(connectionWasStable(WS_RECONNECT.minStableMs)).toBe(true);
    expect(connectionWasStable(60_000)).toBe(true);
  });
});

describe("shouldAttemptAfterGaveUp", () => {
  it("allows an attempt when we have not given up (null)", () => {
    expect(shouldAttemptAfterGaveUp(null, 1_000_000)).toBe(true);
  });

  it("blocks a restart within the cooldown after giving up", () => {
    const gaveUpAt = 1_000_000;
    expect(shouldAttemptAfterGaveUp(gaveUpAt, gaveUpAt + 5_000)).toBe(false);
  });

  it("allows a restart once the cooldown has elapsed", () => {
    const gaveUpAt = 1_000_000;
    expect(shouldAttemptAfterGaveUp(gaveUpAt, gaveUpAt + WS_RECONNECT.gaveUpCooldownMs)).toBe(true);
  });
});

describe("shouldSampleDisconnect", () => {
  it("keeps the first few disconnects so the storm's onset is visible", () => {
    expect(shouldSampleDisconnect(1)).toBe(true);
    expect(shouldSampleDisconnect(3)).toBe(true);
  });

  it("drops the mid-storm floods but keeps every Nth", () => {
    expect(shouldSampleDisconnect(4)).toBe(false);
    expect(shouldSampleDisconnect(9)).toBe(false);
    expect(shouldSampleDisconnect(10)).toBe(true); // every 10th
    expect(shouldSampleDisconnect(20)).toBe(true);
  });
});

describe("shouldReconnect", () => {
  it("reconnects while mounted, with a token, under the cap", () => {
    expect(
      shouldReconnect({ attempt: 0, unmounted: false, hasToken: true }),
    ).toBe(true);
  });

  it("stops when unmounted", () => {
    expect(
      shouldReconnect({ attempt: 0, unmounted: true, hasToken: true }),
    ).toBe(false);
  });

  it("stops without a token", () => {
    expect(
      shouldReconnect({ attempt: 0, unmounted: false, hasToken: false }),
    ).toBe(false);
  });

  it("stops at the attempt cap", () => {
    expect(
      shouldReconnect({
        attempt: WS_RECONNECT.maxAttempts,
        unmounted: false,
        hasToken: true,
      }),
    ).toBe(false);
  });

  it("honors a custom maxAttempts", () => {
    expect(
      shouldReconnect({
        attempt: 2,
        unmounted: false,
        hasToken: true,
        maxAttempts: 2,
      }),
    ).toBe(false);
  });
});

describe("parseLiveMessage", () => {
  it("decodes a scores_updated message with round id", () => {
    expect(
      parseLiveMessage('{"type":"scores_updated","round_id":"r9"}'),
    ).toEqual({ type: "scores_updated", roundId: "r9" });
  });

  it("decodes the server's app-level heartbeat as a ping no-op", () => {
    expect(parseLiveMessage('{"type":"ping"}')).toEqual({ type: "ping" });
  });

  it("returns unknown for an unrecognized type", () => {
    expect(parseLiveMessage('{"type":"something_else"}')).toEqual({
      type: "unknown",
    });
  });

  it("returns unknown (never throws) on malformed JSON", () => {
    expect(parseLiveMessage("not json")).toEqual({ type: "unknown" });
  });
});

describe("isStaleConnection", () => {
  it("is false within the idle window", () => {
    expect(isStaleConnection(1_000, 1_000 + WS_IDLE_MS - 1)).toBe(false);
  });

  it("is true at/after the idle window", () => {
    expect(isStaleConnection(1_000, 1_000 + WS_IDLE_MS)).toBe(true);
  });

  it("accepts a custom idle window", () => {
    expect(isStaleConnection(0, 500, 400)).toBe(true);
  });
});
