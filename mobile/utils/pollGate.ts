// utils/pollGate.ts
// Decides WHEN a freshly-polled scorecard snapshot may be merged into local state.
//
// Why this exists — the bug it makes structurally impossible:
//
// The scorecard screen is ~1900 lines. Merging a server snapshot runs a 3-way merge and
// three setStates, which re-renders and REFLOWS that whole tree. If a reflow lands between
// a pill's onPressIn and its onPress, React Native drops the press: the pill visibly dims
// and nothing happens. That is exactly the "FIR/GIR pills are undroppable" bug players hit
// on 7/7 and again on 7/11.
//
// Its old trigger was the live-score WebSocket, which echoed every save back to the device
// that made it — so every tap caused a refetch that could cancel the NEXT tap. The socket is
// gone (peers are picked up by a 60s poll instead), which removes that feedback loop. But a
// 60s poll can still, by chance, land mid-gesture. Rather than shrink the window and hope,
// this gate closes it: a snapshot is applied only while the user is demonstrably NOT
// interacting. Anything held is applied moments later, when they go idle — nobody can
// perceive the difference on a 60s cadence, and no tap can ever be eaten again.
//
// Pure and injectable (no timers, no clock reads) so it is fully unit-tested — the
// extract-first rule: the screen file is coverage-excluded, this is not.

// POLL_QUIET_MS is how long after the last tap/keystroke a snapshot must wait. It needs to
// comfortably exceed the scorecard's own save debounces (250ms for stat pills, 400ms for
// scores/numeric inputs) plus the round trip they trigger, so that a merge doesn't land in
// the middle of a burst of taps — a player entering a hole's stats taps FIR, GIR, club, and
// putts in quick succession, and every one of those must survive.
export const POLL_QUIET_MS = 3000;

// PollGateInput is the live interaction state the screen tracks in refs.
export interface PollGateInput {
  // inFlightSaves counts saves that have been dispatched but not yet settled. A snapshot
  // merged while a save is in flight can also deliver a STALE server view (it may not
  // include the write still on the wire), so holding here protects correctness, not just
  // the gesture.
  inFlightSaves: number;
  // msSinceLastInteraction is time since the last pill tap, keystroke, or hole change.
  msSinceLastInteraction: number;
  quietMs?: number;
}

// shouldApplyPolledSnapshot returns true when it is safe to merge a polled snapshot into
// local state: no save is in flight AND the user has been quiet for at least quietMs.
//
// A negative msSinceLastInteraction (a clock that jumped backwards — NTP correction or a
// timezone shift mid-round) is treated as "just interacted", the conservative reading: hold
// the snapshot rather than risk eating a tap.
export function shouldApplyPolledSnapshot(input: PollGateInput): boolean {
  const quietMs = input.quietMs ?? POLL_QUIET_MS;
  if (input.inFlightSaves > 0) return false;
  if (input.msSinceLastInteraction < 0) return false;
  return input.msSinceLastInteraction >= quietMs;
}
