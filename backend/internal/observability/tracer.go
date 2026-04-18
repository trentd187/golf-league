// tracer.go initialises the OpenTelemetry trace pipeline that pushes spans to
// Grafana Cloud Tempo via the same OTLP HTTP gateway used for metrics.
// The gateway routes each signal type to the correct backend automatically.
package observability

import (
	"context"
	"encoding/base64"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// initTracer creates the OTel trace pipeline. Returns a no-op TracerProvider
// when any of the endpoint, user, or apiKey args are empty — the global tracer
// is still set, so spans are created and discarded rather than causing nil panics.
func initTracer(endpoint, user, apiKey, env string) (*sdktrace.TracerProvider, error) {
	if endpoint == "" || user == "" || apiKey == "" {
		// Register a no-op provider so otel.Tracer() calls always succeed.
		tp := sdktrace.NewTracerProvider()
		otel.SetTracerProvider(tp)
		return tp, nil
	}

	basicAuth := base64.StdEncoding.EncodeToString([]byte(user + ":" + apiKey))

	// WithEndpointURL accepts a full URL (scheme + host + path).
	// WithEndpoint expects only host:port and prepends http:// or https:// itself,
	// which would produce "http://https://..." when the env var is a full URL.
	// The gateway requires the signal-specific path suffix (/v1/traces).
	exp, err := otlptracehttp.New(context.Background(),
		otlptracehttp.WithEndpointURL(endpoint+"/v1/traces"),
		otlptracehttp.WithHeaders(map[string]string{
			"Authorization": "Basic " + basicAuth,
		}),
	)
	if err != nil {
		return nil, err
	}

	res, err := resource.New(context.Background(),
		resource.WithAttributes(
			semconv.ServiceName("golf-league"),
			attribute.String("deployment.environment", env),
		),
	)
	if err != nil {
		return nil, err
	}

	// AlwaysSample: this app has low request volume so we capture every span.
	// Switch to TraceIDRatioBased(0.1) if volume grows and Tempo costs become a concern.
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	)

	otel.SetTracerProvider(tp)

	return tp, nil
}
