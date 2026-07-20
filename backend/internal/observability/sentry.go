// Package observability wires the Sentry Go SDK as the single observability backend
// for the Golf League API: error events, distributed traces, performance profiling,
// and structured logs (via the official sentry-go/slog handler).
//
// Init returns the *slog.Logger the caller should install as the process default;
// errors and above flow to Sentry as Issues, lower levels flow to Sentry Logs.
// A stdout JSON handler runs in parallel so `docker logs` and Railway logs are
// unchanged for local debugging.
package observability

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/getsentry/sentry-go"
	sentryslog "github.com/getsentry/sentry-go/slog"

	"github.com/trentd187/golf-league/internal/config"
)

// Init configures the Sentry SDK and returns the logger to install as the
// process default along with a shutdown closure. The shutdown closure flushes
// any buffered Sentry events with a 2-second budget — call it via defer in main.
//
// When cfg.SentryDSN is empty, Sentry is not initialised: the returned logger
// is a plain stdout JSON handler and shutdown is a no-op. This keeps local dev
// and CI runs free of any network dependency on Sentry.
func Init(cfg *config.Config) (*slog.Logger, func(), error) {
	minLevel := parseLevel(cfg.LogLevel)

	stdoutHandler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: minLevel,
	})

	if cfg.SentryDSN == "" {
		return slog.New(stdoutHandler), func() {}, nil
	}

	// Go SDK v0.46 does not yet expose a ProfilesSampleRate field on ClientOptions —
	// profiling is not a stable surface on sentry-go (it is on the mobile and JS SDKs).
	// We get errors, distributed tracing, and logs here; Go profiling will be added
	// once the SDK exposes the knob.
	if err := sentry.Init(sentry.ClientOptions{
		Dsn:              cfg.SentryDSN,
		Environment:      cfg.Env,
		Release:          cfg.SentryRelease,
		SendDefaultPII:   true,
		AttachStacktrace: true,
		EnableTracing:    true,
		EnableLogs:       true,
		TracesSampleRate: cfg.SentryTracesSampleRate,
	}); err != nil {
		return nil, nil, err
	}

	// The sentryslog handler routes a record to EventLevel and LogLevel independently
	// (see SentryHandler.Handle), so a level in both lists is sent as an Issue *and* a
	// searchable Log.
	//   EventLevel: Error/Fatal → Sentry Issues with stack traces (alerting, grouping).
	//   LogLevel:   every level (incl. Error/Fatal) → Sentry Logs (searchable timeline).
	// Error/Fatal were previously omitted from LogLevel, which is why `level:error`
	// queries in the Logs view returned nothing even when 5xx faults occurred — an
	// error's only sink was an Issue. They now appear in both. (EventLevel is deprecated
	// upstream in favour of LogLevel; kept here until Issues can be driven from logs.)
	sentryHandler := sentryslog.Option{
		EventLevel: []slog.Level{slog.LevelError, sentryslog.LevelFatal},
		LogLevel:   []slog.Level{slog.LevelDebug, slog.LevelInfo, slog.LevelWarn, slog.LevelError, sentryslog.LevelFatal},
		AddSource:  true,
	}.NewSentryHandler(context.Background())

	logger := slog.New(newFanout(stdoutHandler, sentryHandler))

	shutdown := func() {
		// 2s is Sentry's recommended Flush budget — long enough to drain a healthy
		// queue, short enough that Railway's SIGTERM grace window is respected.
		sentry.Flush(2 * time.Second)
	}

	return logger, shutdown, nil
}

// parseLevel converts a string level to slog.Level. Unknown values → info.
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

// fanout dispatches each slog record to multiple downstream handlers.
// Go 1.26 ships slog.NewMultiHandler; on Go 1.25 we use this tiny shim.
type fanout struct {
	handlers []slog.Handler
}

func newFanout(handlers ...slog.Handler) *fanout {
	return &fanout{handlers: handlers}
}

func (f *fanout) Enabled(ctx context.Context, level slog.Level) bool {
	for _, h := range f.handlers {
		if h.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (f *fanout) Handle(ctx context.Context, r slog.Record) error {
	// Detach every string attr from its backing array before dispatch. Fiber's
	// c.Method()/c.Path()/c.Get() return zero-copy strings that alias fasthttp's
	// reused request buffers. The stdout handler serializes synchronously (safe),
	// but the sentry-go handler batches and serializes asynchronously — by then the
	// next request has recycled the buffer, so the logged method/path mutate into
	// garbage (observed in Sentry Logs as "GETT", "/api/v1/meunds/…"). This also
	// taints the 5xx→Issue tags in errorlog.go. strings.Clone copies the bytes into
	// a fresh allocation owned by us, breaking the alias; it runs once here so every
	// current and future producer is covered without touching any call site.
	safe := cloneRecordStrings(r)
	var firstErr error
	for _, h := range f.handlers {
		if !h.Enabled(ctx, safe.Level) {
			continue
		}
		// Clone so downstream handlers that mutate attrs (e.g. via WithAttrs chains)
		// don't see each other's modifications.
		if err := h.Handle(ctx, safe.Clone()); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// cloneRecordStrings returns a copy of r whose string attribute values are
// reallocated via strings.Clone, so none of them alias a caller-owned mutable
// buffer. Non-string values are carried over unchanged; group values recurse.
func cloneRecordStrings(r slog.Record) slog.Record {
	out := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	r.Attrs(func(a slog.Attr) bool {
		out.AddAttrs(cloneAttrStrings(a))
		return true
	})
	return out
}

// cloneAttrStrings deep-copies the string leaves of a single attr. Only KindString
// and KindGroup can hold or contain fasthttp-backed strings; every other kind is
// returned as-is.
func cloneAttrStrings(a slog.Attr) slog.Attr {
	switch a.Value.Kind() {
	case slog.KindString:
		return slog.String(a.Key, strings.Clone(a.Value.String()))
	case slog.KindGroup:
		group := a.Value.Group()
		cloned := make([]slog.Attr, len(group))
		for i, ga := range group {
			cloned[i] = cloneAttrStrings(ga)
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(cloned...)}
	default:
		return a
	}
}

func (f *fanout) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		next[i] = h.WithAttrs(attrs)
	}
	return &fanout{handlers: next}
}

func (f *fanout) WithGroup(name string) slog.Handler {
	next := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		next[i] = h.WithGroup(name)
	}
	return &fanout{handlers: next}
}
