// __tests__/utils/pollGate.test.ts
// Tests for the poll gate — the guard that stops a background scorecard refresh from
// reflowing the screen under the player's finger and eating a FIR/GIR pill tap.
//
// The invariant under test: a snapshot is applied ONLY when no save is in flight AND the
// user has been quiet for at least quietMs. Everything else holds.

import { shouldApplyPolledSnapshot, POLL_QUIET_MS } from "@/utils/pollGate";

describe("shouldApplyPolledSnapshot", () => {
  it("applies the snapshot when the user is idle and nothing is saving", () => {
    expect(
      shouldApplyPolledSnapshot({ inFlightSaves: 0, msSinceLastInteraction: 10_000 }),
    ).toBe(true);
  });

  it("holds the snapshot while a save is in flight, however long the user has been idle", () => {
    // A save on the wire means the server view may not include it yet: merging now could
    // deliver a stale snapshot, not just a badly-timed reflow.
    expect(
      shouldApplyPolledSnapshot({ inFlightSaves: 1, msSinceLastInteraction: 60_000 }),
    ).toBe(false);
  });

  it("holds the snapshot right after a tap — the pill-cancellation window", () => {
    // 300ms after a tap is precisely when the old WS echo used to land and cancel the
    // player's next press.
    expect(shouldApplyPolledSnapshot({ inFlightSaves: 0, msSinceLastInteraction: 300 })).toBe(
      false,
    );
  });

  it("holds until the quiet period has fully elapsed, then applies", () => {
    expect(
      shouldApplyPolledSnapshot({ inFlightSaves: 0, msSinceLastInteraction: POLL_QUIET_MS - 1 }),
    ).toBe(false);
    expect(
      shouldApplyPolledSnapshot({ inFlightSaves: 0, msSinceLastInteraction: POLL_QUIET_MS }),
    ).toBe(true);
  });

  it("honours a caller-supplied quietMs over the default", () => {
    expect(
      shouldApplyPolledSnapshot({
        inFlightSaves: 0,
        msSinceLastInteraction: 500,
        quietMs: 200,
      }),
    ).toBe(true);
    expect(
      shouldApplyPolledSnapshot({
        inFlightSaves: 0,
        msSinceLastInteraction: 500,
        quietMs: 1000,
      }),
    ).toBe(false);
  });

  it("holds when the clock jumps backwards mid-round", () => {
    // An NTP correction or timezone shift can make "time since last tap" negative. Treat it
    // as if the user just interacted — the conservative reading, since the cost of holding
    // is a delayed merge and the cost of applying is an eaten tap.
    expect(shouldApplyPolledSnapshot({ inFlightSaves: 0, msSinceLastInteraction: -5000 })).toBe(
      false,
    );
  });

  it("holds while several saves are in flight (a burst of stat taps)", () => {
    expect(
      shouldApplyPolledSnapshot({ inFlightSaves: 3, msSinceLastInteraction: 10_000 }),
    ).toBe(false);
  });

  it("defaults quietMs to POLL_QUIET_MS, which exceeds the screen's save debounces", () => {
    // The scorecard debounces stat taps at 250ms and scores at 400ms. If the quiet period
    // were shorter than those, a merge could fire between a tap and the save it triggers.
    expect(POLL_QUIET_MS).toBeGreaterThan(400);
  });
});
