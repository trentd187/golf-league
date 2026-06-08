// utils/api.ts
// Thin wrapper around the global fetch used for every backend API call.
//
// It no longer injects observability headers. Under Sentry, the SDK's fetch
// instrumentation patches the global fetch and automatically adds the
// `sentry-trace` + `baggage` headers, so a mobile request and the Fiber
// transaction it triggers share one distributed trace with no manual work.
// (The previous X-Correlation-ID / X-Trace-ID wiring belonged to the removed
// Loki/Tempo pipeline.)
//
// The wrapper is kept as the single chokepoint for API requests — a natural place
// to add cross-cutting behavior later — and so call sites read consistently as
// apiFetch(...) rather than raw fetch(...). The returned Response is unchanged;
// callers still call .json() / .ok themselves.

export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, init);
}
