// utils/roundReconcile.ts
// Pure read-back helper for the start-round save path. Starting a round is a
// PATCH /rounds/:id {status:"active"} — idempotent, so savePut retries it. When every
// retry fails on a transport error (a cellular phantom: the PATCH committed but the ack
// was lost), the caller reads the round back and asks this helper whether the status
// already reached the target. A true result lets savePut suppress the false
// "couldn't start round" error, mirroring how scorecard saves reconcile via
// utils/saveReconcile.ts.
//
// Kept pure (no injected collaborators) so it is fully unit-tested while the calling
// screen (app/rounds/[id].tsx) stays coverage-excluded — the extract-first rule.

// RoundStatusLike is the minimal shape we read off a GET /rounds/:id response.
export interface RoundStatusLike {
  status?: string | null;
}

// roundStatusReconciled returns true iff the read-back round already shows expectedStatus.
// A null/undefined round, or one whose status is missing or different, reconciles to false
// (treated as "did not land") so a genuine failure still surfaces.
export function roundStatusReconciled(
  round: RoundStatusLike | null | undefined,
  expectedStatus: string,
): boolean {
  return !!round && round.status === expectedStatus;
}
