// utils/api.ts
// Thin fetch wrapper that attaches observability headers to every outgoing API request
// and captures the backend's trace ID from every response.
//
// Headers injected on every request:
//   - X-Correlation-ID: stable session UUID for Loki log correlation. Lets Loki queries
//     join all frontend log entries and backend request logs for the same session.
//
// traceparent (W3C Trace Context) is NOT set here. On web, FetchInstrumentation
// (tracing.ts) patches globalThis.fetch and injects the correct traceparent from the
// active OTel span context automatically. Setting it manually would be overwritten and
// would cause double-injection. On native, there is no OTel provider, so no traceparent
// is needed — the backend creates root spans for native API calls.
//
// X-Trace-ID in the response is stored on TelemetryClient for reference; it holds the
// backend's trace ID for the most recent request, usable in subsequent log entries.
//
// Usage: replace fetch(`${API_URL}/api/v1/...`) calls with apiFetch(...).
// The returned Response is unchanged — callers still call .json() / .ok themselves.

import { getTelemetryClient } from "@/utils/telemetry";

// apiFetch wraps the global fetch with observability headers.
// init is forwarded unchanged so callers can still set method, headers, body, etc.
export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const client = getTelemetryClient();

  // Merge observability headers into any headers the caller already set.
  const headers = new Headers(init?.headers);
  headers.set("X-Correlation-ID", client.getSessionId());

  const response = await fetch(input, { ...init, headers });

  // Capture the backend's trace ID so the next log entry can reference it.
  const traceId = response.headers.get("X-Trace-ID");
  if (traceId) {
    client.setLastTraceId(traceId);
  }

  return response;
}
