// observability.go is the top-level wiring layer for the Grafana Cloud stack.
// Obs bundles the logger, metrics, tracer, and profiler into one struct so
// main.go can initialise everything with a single call and shut it all down
// cleanly on SIGTERM.
//
// Package-level helpers (LogInfo, LogWarn, etc.) let handlers emit business
// events to Loki without changing their signatures — the default handler is
// set once in main.go via SetDefault.
package observability

import (
	"context"
	"log/slog"
	"time"

	"github.com/grafana/pyroscope-go"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"github.com/trentd187/golf-league/internal/config"
)

// Obs bundles all observability pillars so main.go holds a single reference.
type Obs struct {
	Logger         *slog.Logger
	Metrics        *Metrics
	handler        *LokiHandler
	tracerProvider *sdktrace.TracerProvider
	profiler       *pyroscope.Profiler
}

// Init creates all observability components from the supplied config.
// Components whose env vars are absent degrade to no-ops — the server runs
// normally without any telemetry credentials set.
func Init(cfg *config.Config, wsConnCount func() int32) (*Obs, error) {
	minLevel := parseLevel(cfg.LogLevel)

	h := NewLokiHandler(cfg.LokiURL, cfg.LokiUser, cfg.LokiAPIKey, cfg.Env, minLevel)
	// Wrap the LokiHandler so the stdlib slog global also writes through it.
	logger := slog.New(&slogBridge{h: h})

	m, err := initMetrics(cfg.OTLPURL, cfg.OTLPUser, cfg.OTLPAPIKey, cfg.Env, wsConnCount)
	if err != nil {
		return nil, err
	}

	tp, err := initTracer(cfg.OTLPURL, cfg.OTLPUser, cfg.OTLPAPIKey, cfg.Env)
	if err != nil {
		return nil, err
	}

	prof, err := initPyroscope(cfg.PyroscopeURL, cfg.PyroscopeUser, cfg.PyroscopeAPIKey, cfg.Env)
	if err != nil {
		return nil, err
	}

	return &Obs{
		Logger:         logger,
		Metrics:        m,
		handler:        h,
		tracerProvider: tp,
		profiler:       prof,
	}, nil
}

// Handler returns the LokiHandler for wiring into handlers.PostMobileLogs.
func (o *Obs) Handler() *LokiHandler {
	return o.handler
}

// Shutdown drains logs, flushes metrics, stops traces, and stops profiling.
// Uses a 10-second context so the process exits cleanly even under load.
func (o *Obs) Shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	o.handler.Shutdown()
	o.Metrics.Shutdown(ctx)

	if o.tracerProvider != nil {
		_ = o.tracerProvider.Shutdown(ctx)
	}

	if o.profiler != nil {
		_ = o.profiler.Stop()
	}
}

// ── Package-level default handler ────────────────────────────────────────────
// Handlers call observability.LogInfo(...) etc. without holding an *Obs pointer.
// main.go calls SetDefault(obs.Handler()) after Init.

var defaultHandler *LokiHandler

// SetDefault stores the handler that package-level log helpers will use.
func SetDefault(h *LokiHandler) {
	defaultHandler = h
}

// LogDebug emits a DEBUG-level business event through the default handler.
func LogDebug(ctx context.Context, eventType, msg string, args ...any) {
	logEvent(ctx, slog.LevelDebug, eventType, msg, args...)
}

// LogInfo emits an INFO-level business event through the default handler.
func LogInfo(ctx context.Context, eventType, msg string, args ...any) {
	logEvent(ctx, slog.LevelInfo, eventType, msg, args...)
}

// LogWarn emits a WARN-level business event through the default handler.
func LogWarn(ctx context.Context, eventType, msg string, args ...any) {
	logEvent(ctx, slog.LevelWarn, eventType, msg, args...)
}

// LogError emits an ERROR-level business event through the default handler.
func LogError(ctx context.Context, eventType, msg string, args ...any) {
	logEvent(ctx, slog.LevelError, eventType, msg, args...)
}

// logEvent is the shared implementation — prepends event_type to the args list
// so it appears as a structured field in both stdout JSON and Loki.
func logEvent(ctx context.Context, level slog.Level, eventType, msg string, args ...any) {
	if defaultHandler == nil {
		return
	}
	// Prepend event_type so it appears as the first field in both stdout and Loki.
	allArgs := append([]any{"event_type", eventType}, args...)
	defaultHandler.Log(ctx, level, msg, allArgs...)
}

// parseLevel converts a string like "debug" or "warn" to the corresponding
// slog.Level. Unknown values default to slog.LevelInfo.
func parseLevel(s string) slog.Level {
	switch s {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// ── slogBridge ───────────────────────────────────────────────────────────────
// slogBridge adapts LokiHandler to the slog.Handler interface so slog.SetDefault
// can route stdlib slog calls through our handler without duplicating logic.

type slogBridge struct {
	h *LokiHandler
}

func (b *slogBridge) Enabled(_ context.Context, level slog.Level) bool {
	return level >= b.h.minLevel
}

func (b *slogBridge) Handle(ctx context.Context, r slog.Record) error {
	attrs := make([]any, 0, r.NumAttrs()*2)
	r.Attrs(func(a slog.Attr) bool {
		attrs = append(attrs, a.Key, a.Value.Any())
		return true
	})
	b.h.Log(ctx, r.Level, r.Message, attrs...)
	return nil
}

func (b *slogBridge) WithAttrs(attrs []slog.Attr) slog.Handler {
	// For simplicity we don't propagate pre-set attrs — all attrs are passed per call.
	return b
}

func (b *slogBridge) WithGroup(_ string) slog.Handler {
	return b
}
