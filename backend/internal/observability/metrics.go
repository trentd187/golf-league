// metrics.go initialises the OpenTelemetry metrics pipeline that pushes to
// Grafana Cloud Mimir via the OTLP HTTP gateway. When the endpoint env vars
// are not set the function returns a no-op Metrics value — callers never need
// nil-checks.
package observability

import (
	"context"
	"encoding/base64"
	"strconv"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Metrics holds all OTel instrument handles for the application.
// A zero-value Metrics is safe to use — all instruments are no-ops.
type Metrics struct {
	provider *metric.MeterProvider

	HTTPRequestsTotal   otelmetric.Int64Counter
	HTTPRequestDuration otelmetric.Float64Histogram
	WSConnectionsActive otelmetric.Int64ObservableGauge // read via callback
	RoundsCreatedTotal  otelmetric.Int64Counter
	EventsCreatedTotal  otelmetric.Int64Counter
}

// RecordHTTP records one HTTP request's method, route pattern, status code, and duration.
// Route must be the Fiber route pattern (e.g. "/rounds/:roundId") — never the raw URL,
// which would create a new metric series per UUID and blow the 10k-series free-tier limit.
func (m *Metrics) RecordHTTP(ctx context.Context, method, route string, statusCode int, duration time.Duration) {
	if m.HTTPRequestsTotal == nil {
		return
	}
	attrs := []attribute.KeyValue{
		attribute.String("method", method),
		attribute.String("route", route),
		attribute.String("status_code", strconv.Itoa(statusCode)),
	}
	m.HTTPRequestsTotal.Add(ctx, 1, otelmetric.WithAttributes(attrs...))
	m.HTTPRequestDuration.Record(ctx, duration.Seconds(), otelmetric.WithAttributes(
		attribute.String("route", route),
	))
}

// Shutdown flushes pending metric data and releases resources.
func (m *Metrics) Shutdown(ctx context.Context) {
	if m.provider != nil {
		_ = m.provider.Shutdown(ctx)
	}
}

// initMetrics creates the OTel metric pipeline. Returns a no-op *Metrics when
// any of the endpoint, user, or apiKey args are empty.
func initMetrics(endpoint, user, apiKey, env string, wsConnCount func() int32) (*Metrics, error) {
	if endpoint == "" || user == "" || apiKey == "" {
		return &Metrics{}, nil
	}

	basicAuth := base64.StdEncoding.EncodeToString([]byte(user + ":" + apiKey))

	// WithEndpointURL accepts a full URL (scheme + host + path).
	// WithEndpoint expects only host:port and prepends http:// or https:// itself,
	// which would produce "http://https://..." when the env var is a full URL.
	// The gateway path is /otlp; the signal-specific suffix is /v1/metrics.
	exp, err := otlpmetrichttp.New(context.Background(),
		otlpmetrichttp.WithEndpointURL(endpoint+"/otlp/v1/metrics"),
		otlpmetrichttp.WithHeaders(map[string]string{
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

	provider := metric.NewMeterProvider(
		metric.WithReader(metric.NewPeriodicReader(exp, metric.WithInterval(60*time.Second))),
		metric.WithResource(res),
	)
	otel.SetMeterProvider(provider)

	m := &Metrics{provider: provider}
	if err := m.registerInstruments(provider.Meter("golf-league"), wsConnCount); err != nil {
		return nil, err
	}

	return m, nil
}

// registerInstruments creates all application metric instruments on the given meter.
func (m *Metrics) registerInstruments(meter otelmetric.Meter, wsConnCount func() int32) error {
	var err error

	m.HTTPRequestsTotal, err = meter.Int64Counter("golf_http_requests_total",
		otelmetric.WithDescription("Total number of HTTP requests"),
	)
	if err != nil {
		return err
	}

	m.HTTPRequestDuration, err = meter.Float64Histogram("golf_http_request_duration_seconds",
		otelmetric.WithDescription("HTTP request latency in seconds"),
		otelmetric.WithExplicitBucketBoundaries(0.05, 0.1, 0.25, 0.5, 1.0, 2.5),
	)
	if err != nil {
		return err
	}

	m.WSConnectionsActive, err = meter.Int64ObservableGauge("golf_websocket_connections_active",
		otelmetric.WithDescription("Number of active WebSocket connections"),
	)
	if err != nil {
		return err
	}

	// The gauge is read-only from outside — we register a callback that reads the
	// hub's atomic counter each time the SDK collects metrics.
	_, err = meter.RegisterCallback(func(_ context.Context, o otelmetric.Observer) error {
		o.ObserveInt64(m.WSConnectionsActive, int64(wsConnCount()))
		return nil
	}, m.WSConnectionsActive)
	if err != nil {
		return err
	}

	m.RoundsCreatedTotal, err = meter.Int64Counter("golf_rounds_created_total",
		otelmetric.WithDescription("Total number of rounds created"),
	)
	if err != nil {
		return err
	}

	m.EventsCreatedTotal, err = meter.Int64Counter("golf_events_created_total",
		otelmetric.WithDescription("Total number of events created"),
	)
	if err != nil {
		return err
	}

	return nil
}
