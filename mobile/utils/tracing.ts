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
      new FetchInstrumentation(),
      // DocumentLoadInstrumentation records navigation and resource timing,
      // providing Core Web Vitals (FCP, LCP, etc.) as Tempo span attributes.
      new DocumentLoadInstrumentation(),
    ],
    tracerProvider: provider,
  });
}
