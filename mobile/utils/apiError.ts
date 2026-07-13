// utils/apiError.ts
// The error type the read path throws, and the predicates that classify it.
//
// Split into its own module so both utils/apiGet.ts (which throws it) and utils/sentry.ts
// (which decides whether to re-report it) can import it without an import cycle.

// ApiError is what apiGetJson/apiGet reject with. It carries two things a plain Error can't:
//
//   status   — the HTTP status, when the server actually answered. undefined means the
//              request never completed a round trip (timeout, radio drop, DNS) — the
//              cellular last-mile failure this whole app is hardened against.
//   reported — whether the read path has ALREADY sent this to Sentry. apiGet reports its own
//              failures (with a connection snapshot and an endpoint label, which is far more
//              useful than anything a generic handler could reconstruct), so the QueryCache
//              handler must not report it a second time. Without this flag every failed read
//              would produce two Sentry events.
export class ApiError extends Error {
  readonly status?: number;
  readonly reported: boolean;
  readonly label?: string;

  constructor(message: string, opts: { status?: number; reported?: boolean; label?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.reported = opts.reported ?? false;
    this.label = opts.label;
  }
}

// isClientError reports whether an error is a 4xx — a definitive answer from the server (bad
// id, not a member, expired token). These never heal on retry, so retrying one only burns the
// player's battery and radio.
export function isClientError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
  );
}

// isAlreadyReported reports whether the read path has already sent this error to Sentry.
export function isAlreadyReported(error: unknown): boolean {
  return error instanceof ApiError && error.reported;
}
