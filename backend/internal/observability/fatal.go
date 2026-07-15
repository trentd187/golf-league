// fatal.go — the one way this process is allowed to die.
//
// Startup failures are the highest-severity events the service can have (a dead database, a
// failed migration, an unreachable JWKS) and they used to be the ONLY ones with no telemetry
// at all. Two reasons, both easy to miss:
//
//  1. log.Fatal writes through the STDLIB logger, which never touches slog — so it never
//     reaches the Sentry slog handler installed by Init(). The crash is stderr-only.
//  2. log.Fatal calls os.Exit(1), and os.Exit skips deferred calls — so even a buffered
//     Sentry event would not have flushed on the way out.
//
// Net effect: a Railway crashloop produced ZERO Sentry signal. Fatal fixes both halves —
// slog.Error routes to Sentry, and the EXPLICIT Flush is required precisely because the
// os.Exit below skips the `defer sentryShutdown()` in main.
//
// Lives here, rather than in package main, so middleware (which loads the JWKS and must die
// if it cannot) can reach it without an import cycle: observability imports only config.
package observability

import (
	"log/slog"
	"os"
	"time"

	"github.com/getsentry/sentry-go"
)

// fatalFlushTimeout is how long we give Sentry to deliver the event before exiting. The
// process is already unusable, so a short block is a cheap price for not losing the only
// record of why it died.
const fatalFlushTimeout = 2 * time.Second

// exitFunc is os.Exit in production, overridden in tests so asserting the startup-failure
// contract does not kill the test binary.
var exitFunc = os.Exit

// Fatal reports an unrecoverable startup failure to Sentry and exits non-zero.
//
// Use this for ANY failure that must stop the process. Never call log.Fatal / os.Exit
// directly — that is the silent-crash bug this exists to prevent. The single exception is a
// failure of Sentry initialisation itself, which by definition cannot be reported to Sentry.
func Fatal(msg string, err error) {
	slog.Error(msg,
		"event_type_label", "server.startup_failed",
		"error", err.Error(),
	)
	sentry.Flush(fatalFlushTimeout)
	exitFunc(1)
}
