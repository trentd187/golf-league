// fatal_test.go — pins the contract that a startup death is VISIBLE before it exits.
//
// This is not a formality. The bug Fatal exists to prevent is invisible by construction: a
// log.Fatal crashloop looks identical to a Fatal crashloop from the outside (exit 1, a line on
// stderr) — the difference is only whether anything reached Sentry. So the regression this
// guards against cannot be caught by observing the process; it has to be asserted here.
package observability

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"
)

// TestFatal_LogsThenExitsNonZero asserts all three halves of the contract at once: it logs at
// ERROR (the only level the Sentry slog handler escalates to an Issue), it carries the stable
// event_type_label an alert can key on, and it exits non-zero.
func TestFatal_LogsThenExitsNonZero(t *testing.T) {
	var buf bytes.Buffer
	prevLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prevLogger) })

	var gotCode int
	var exited bool
	prevExit := exitFunc
	exitFunc = func(code int) {
		gotCode = code
		exited = true
	}
	t.Cleanup(func() { exitFunc = prevExit })

	Fatal("Failed to connect to database", errDBDown)

	if !exited {
		t.Fatal("Fatal did not exit — a startup failure must stop the process")
	}
	if gotCode == 0 {
		t.Errorf("exit code = %d, want non-zero: a zero exit tells Railway the crash was a clean shutdown", gotCode)
	}

	var rec map[string]any
	if err := json.Unmarshal(buf.Bytes(), &rec); err != nil {
		t.Fatalf("Fatal emitted no parseable log line (%v) — the crash would be invisible in Sentry", err)
	}

	// ERROR specifically: the Sentry slog handler only escalates error-and-above to an Issue.
	// A warn here would land in Logs and page nobody.
	if rec["level"] != "ERROR" {
		t.Errorf("level = %v, want ERROR (only ERROR becomes a Sentry Issue)", rec["level"])
	}
	if rec["event_type_label"] != "server.startup_failed" {
		t.Errorf("event_type_label = %v, want server.startup_failed", rec["event_type_label"])
	}
	if rec["msg"] != "Failed to connect to database" {
		t.Errorf("msg = %v, want the caller's message", rec["msg"])
	}
	// The cause must survive — a startup event that says "it failed" without saying why
	// sends whoever is on call straight back to the Railway logs we are trying to replace.
	if rec["error"] != errDBDown.Error() {
		t.Errorf("error = %v, want %q", rec["error"], errDBDown.Error())
	}
}

// errDBDown stands in for any unrecoverable startup cause.
var errDBDown = errStartup("dial tcp 10.0.0.1:5432: connect: connection refused")

type errStartup string

func (e errStartup) Error() string { return string(e) }
