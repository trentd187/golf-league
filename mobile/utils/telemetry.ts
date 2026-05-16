// utils/telemetry.ts
// Client-side telemetry for the Golf League mobile app.
//
// Mobile clients cannot safely embed Loki credentials (they would be extractable
// from the APK/IPA). Instead, this module queues structured log entries and POSTs
// them to /api/v1/telemetry/logs using the user's Supabase JWT — the backend proxies
// them to Loki with server-side credentials.
//
// Distributed trace linking works via two mechanisms:
//   - traceparent (W3C Trace Context): sent as a header on every API request via
//     apiFetch. Contains the session's stable 128-bit trace ID and a per-request
//     span ID. The backend's otelfiber middleware reads this and creates child spans
//     under the same trace ID, so all backend work for a session shares one trace in Tempo.
//   - trace_id / correlation_id fields: included in every log entry so Loki entries
//     can be correlated with Tempo traces for the same session.

import * as ExpoCrypto from "expo-crypto";

import { API_URL } from "@/constants/api";

// Determined at bundle time by Metro/Hermes. __DEV__ is true in Expo Go and
// dev-client builds, false in EAS production builds and standalone apps.
// This mirrors how the backend reads its ENV environment variable.
const APP_ENV = __DEV__ ? "development" : "production";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface QueueEntry {
  level: LogLevel;
  event_type: string;
  message: string;
  timestamp: string; // ISO 8601
  fields: Record<string, unknown>;
}

type TokenGetter = () => Promise<string | null>;

class TelemetryClient {
  // Stable session identifier sent as X-Correlation-ID on every API request.
  // Allows joining mobile Loki entries with backend Tempo spans for the same session.
  private readonly sessionId: string;

  // 128-bit trace ID for this session, formatted as 32 lowercase hex chars.
  // Sent in the W3C traceparent header on every API request so the backend creates
  // child spans under this trace ID — all backend work for the session shares one
  // root trace in Tempo.
  private readonly traceId: string;

  // Most recent trace ID received from the backend in an X-Trace-ID response header.
  // After traceparent propagation this equals traceId; kept for legacy compatibility.
  private lastTraceId: string | null = null;

  private readonly queue: QueueEntry[] = [];
  private getToken: TokenGetter | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Use expo-crypto rather than the global crypto object — the global is not
    // available in all Hermes/React Native environments (e.g. older Expo Go builds).
    this.sessionId = ExpoCrypto.randomUUID();
    // Strip dashes to produce 32 lowercase hex chars as required by W3C Trace Context.
    this.traceId = ExpoCrypto.randomUUID().replace(/-/g, "");
  }

  // setTokenGetter is called from _layout.tsx after auth loads so the client
  // can attach the Supabase JWT to flush requests. Triggers an immediate flush if
  // entries are already queued.
  setTokenGetter(fn: TokenGetter): void {
    this.getToken = fn;
    if (this.queue.length > 0) {
      void this.flush();
    }
  }

  // getSessionId exposes the stable session UUID so apiFetch can attach it as
  // the X-Correlation-ID request header on every API call.
  getSessionId(): string {
    return this.sessionId;
  }

  // getTraceparent returns a W3C traceparent header value for one outgoing request.
  // The trace ID is stable for the session; the span ID is fresh per call so each
  // request gets a unique parent span ID in the backend trace.
  // Format: 00-{32-hex traceId}-{16-hex spanId}-01  (version-traceId-parentSpanId-sampled)
  getTraceparent(): string {
    const spanId = ExpoCrypto.randomUUID().replace(/-/g, "").slice(0, 16);
    return `00-${this.traceId}-${spanId}-01`;
  }

  // setLastTraceId stores the trace ID from the most recent X-Trace-ID response
  // header. Called by apiFetch after every API response.
  setLastTraceId(id: string): void {
    this.lastTraceId = id;
  }

  // log queues a structured entry. correlation_id and trace_id are merged in
  // automatically — callers don't need to pass them.
  log(
    level: LogLevel,
    event_type: string,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    const entry: QueueEntry = {
      level,
      event_type,
      message,
      timestamp: new Date().toISOString(),
      fields: {
        ...fields,
        correlation_id: this.sessionId,
        trace_id: this.traceId,
        env: APP_ENV,
      },
    };

    this.queue.push(entry);

    // Flush immediately at 20 entries to stay within the 100-entry server cap.
    if (this.queue.length >= 20) {
      void this.flush();
      return;
    }

    // Otherwise arm a 30-second timer so entries don't sit forever.
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, 30_000);
    }
  }

  // Convenience level methods so callers can write telemetry.error(...) etc.
  debug(event_type: string, message: string, fields?: Record<string, unknown>): void {
    this.log("debug", event_type, message, fields);
  }

  info(event_type: string, message: string, fields?: Record<string, unknown>): void {
    this.log("info", event_type, message, fields);
  }

  warn(event_type: string, message: string, fields?: Record<string, unknown>): void {
    this.log("warn", event_type, message, fields);
  }

  error(event_type: string, message: string, fields?: Record<string, unknown>): void {
    this.log("error", event_type, message, fields);
  }

  // flush sends all queued entries to the backend in one request.
  // JS is single-threaded so snapshot + clear is atomic — no race conditions.
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.queue.length === 0 || !this.getToken) {
      return;
    }

    const entries = this.queue.splice(0, this.queue.length);

    let token: string | null = null;
    try {
      token = await this.getToken();
    } catch {
      // Token unavailable (e.g. signed out) — re-queue entries and try later.
      this.queue.unshift(...entries);
      return;
    }

    if (!token) {
      this.queue.unshift(...entries);
      return;
    }

    try {
      await fetch(`${API_URL}/api/v1/telemetry/logs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Correlation-ID": this.sessionId,
        },
        body: JSON.stringify({ entries }),
      });
    } catch {
      // Network failure — drop silently. Logs are best-effort, not critical path.
      if (__DEV__) {
        console.warn("[telemetry] flush failed — entries dropped");
      }
    }
  }

  // stopTimer cancels the pending flush timer. Call on sign-out cleanup.
  stopTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// Module-level singleton — one client per app process.
let _client: TelemetryClient | null = null;

export function getTelemetryClient(): TelemetryClient {
  if (!_client) {
    _client = new TelemetryClient();
  }
  return _client;
}
