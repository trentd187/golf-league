// utils/api.ts
// Thin fetch wrapper that attaches the session correlation ID to every outgoing
// API request and captures the backend's trace ID from every response.
//
// Why this exists:
//   - X-Correlation-ID links a mobile session's Loki log entries with backend
//     Tempo spans for the same request (backend's correlation middleware reads it
//     and tags the span).
//   - X-Trace-ID (from the backend response) is stored on the TelemetryClient so
//     subsequent mobile log entries can reference the exact backend trace span,
//     making it possible to jump from a Loki error directly to the Tempo trace.
//
// Usage: replace all fetch(`${API_URL}/api/v1/...`) calls with apiFetch(`${API_URL}/api/v1/...`).
// The returned Response is unchanged — callers still call .json() / .ok themselves.

import { getTelemetryClient } from "@/utils/telemetry";

// apiFetch wraps the global fetch with observability headers.
// init is forwarded unchanged so callers can still set method, headers, body, etc.
export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const client = getTelemetryClient();

  // Merge our correlation header into any headers the caller already set.
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
