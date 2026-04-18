// utils/telemetry.ts
// Client-side telemetry for the Golf League mobile app.
//
// Mobile clients cannot safely embed Loki credentials (they would be extractable
// from the APK/IPA). Instead, this module queues structured log entries and POSTs
// them to /api/v1/telemetry/logs using the user's Clerk JWT — the backend proxies
// them to Loki with server-side credentials.
//
// Correlation with backend traces works via two fields automatically included in
// every log entry:
//   - correlation_id: a stable UUID generated on app launch (same value sent as
//     X-Correlation-ID on every API request via apiFetch)
//   - trace_id: the backend's trace ID from the most recent API response
//     (X-Trace-ID response header, captured by apiFetch)

import { API_URL } from "@/constants/api";

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

  // Most recent trace ID received from the backend in an X-Trace-ID response header.
  // Included in log entries so a Loki error can link directly to a Tempo span.
  private lastTraceId: string | null = null;

  private queue: QueueEntry[] = [];
  private getToken: TokenGetter | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // crypto.randomUUID() is available in React Native's Hermes engine (>= 0.71).
    this.sessionId = crypto.randomUUID();
  }

  // setTokenGetter is called from _layout.tsx after ClerkLoaded so the client
  // can attach the Clerk JWT to flush requests. Triggers an immediate flush if
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
        ...(this.lastTraceId ? { trace_id: this.lastTraceId } : {}),
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
