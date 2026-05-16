// utils/api.ts
// Thin fetch wrapper that attaches observability headers to every outgoing API request
// and captures the backend's trace ID from every response.
//
// Headers injected on every request:
//   - traceparent (W3C Trace Context): session trace ID + per-request span ID.
//     The backend's otelfiber middleware reads this and creates child spans under
//     the same trace ID, linking all backend work for the session in Tempo.
//   - X-Correlation-ID: stable session UUID for Loki log correlation (legacy;
//     kept alongside traceparent for backwards compatibility with existing queries).
//
// X-Trace-ID in the response is stored on TelemetryClient for reference; after
// traceparent propagation it equals the session trace ID already present in logs.
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
  headers.set("traceparent", client.getTraceparent());
  headers.set("X-Correlation-ID", client.getSessionId());

  const response = await fetch(input, { ...init, headers });

  // Capture the backend's trace ID so the next log entry can reference it.
  const traceId = response.headers.get("X-Trace-ID");
  if (traceId) {
    client.setLastTraceId(traceId);
  }

  return response;
}
