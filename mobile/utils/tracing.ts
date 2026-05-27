// utils/tracing.ts
// Initializes the OpenTelemetry browser tracer for web builds.
//
// On web this wires up three things:
//   1. FetchInstrumentation — injects traceparent headers into every fetch() call so
//      backend child spans link to the browser span in Tempo (replacing phantom parent IDs)
//   2. DocumentLoadInstrumentation — records Core Web Vitals (FCP, LCP, navigation timing)
//   3. OTLPTraceExporter — sends spans to /otlp/v1/traces (same origin, no CORS);
//      Caddy proxies to Grafana Cloud Tempo and injects auth server-side
//
// On native, initWebTracing() returns immediately. The OTel packages are bundled
// (Metro resolves all imports statically) but the SDK objects are never constructed,
// so no browser globals are accessed and there is no runtime overhead.
//
// ignoreUrls in FetchInstrumentation keeps three categories of request out of Tempo:
//   - /otlp/v1/traces: the OTLPTraceExporter itself uses fetch(); without this exclusion
//     every export creates a new span that gets exported, creating a self-perpetuating loop
//     that fills the BatchSpanProcessor queue with ~2048 spans and crashes the renderer.
//   - /api/v1/telemetry/logs: internal 30-second flush requests are noise in Tempo and
//     compound the loop since each flush is also a fetch().
//   - supabase.co/auth: Supabase token refresh and getUser() are cross-origin calls to
//     supabase.co. FetchInstrumentation cannot inject traceparent into cross-origin requests
//     without explicit propagateTraceHeaderCorsUrls config, so these spans have no parent
//     link and only add PerformanceObserver overhead — each active span registers an observer
//     that fires for every resource load (including player avatar <img> tags), contributing
//     to memory pressure when many avatars load simultaneously on the scorecard screen.

import { Platform } from "react-native";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

let initialized = false;

// initWebTracing sets up the OTel browser tracer. Idempotent — only the first
// call does work; subsequent calls are no-ops (safe to call on every render cycle).
export function initWebTracing(): void {
  if (Platform.OS !== "web" || initialized) return;
  initialized = true;

  // Use window.location.origin so the exporter URL is always the same origin as
  // the page — works in both local docker-compose (http://localhost:3000) and
  // Railway production (https://golf-web.up.railway.app).
  const exporter = new OTLPTraceExporter({
    url: `${window.location.origin}/otlp/v1/traces`,
  });

  // In OTel SDK v2, span processors are passed in the constructor config rather
  // than via addSpanProcessor() which was removed.
  const provider = new WebTracerProvider({
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  // register() sets both the global TracerProvider and the W3C propagator so
  // FetchInstrumentation writes traceparent headers that the backend reads.
  provider.register({ propagator: new W3CTraceContextPropagator() });

  registerInstrumentations({
    instrumentations: [
      // FetchInstrumentation patches globalThis.fetch and injects traceparent into
      // every outgoing request. Same-origin requests (our API) are always propagated.
      // See file-level comment for the rationale behind each ignoreUrls entry.
      new FetchInstrumentation({
        ignoreUrls: [
          /\/otlp\/v1\/traces/,
          /\/api\/v1\/telemetry\/logs/,
          /supabase\.co\/auth/,
        ],
      }),
      // DocumentLoadInstrumentation records navigation and resource timing,
      // providing Core Web Vitals (FCP, LCP, etc.) as Tempo span attributes.
      new DocumentLoadInstrumentation(),
    ],
    tracerProvider: provider,
  });
}
