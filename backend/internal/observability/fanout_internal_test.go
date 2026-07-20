// fanout_internal_test.go — white-box tests for the slog fanout.
//
// These live in `package observability` (not `_test`) because they exercise the
// unexported fanout and its string-cloning boundary directly. The behaviour under
// test is the fix for corrupted Sentry log/Issue strings: Fiber returns zero-copy
// method/path strings that alias fasthttp's reused request buffers, and the
// asynchronous sentry-go handler serialized them after the buffer was recycled.
// fanout.Handle must detach those strings before dispatch.
package observability

import (
	"context"
	"log/slog"
	"testing"
	"time"
	"unsafe"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// captureHandler is a minimal slog.Handler that records the attrs of the last
// record it received, so a test can inspect what a downstream handler would see.
type captureHandler struct {
	attrs map[string]string
}

func (h *captureHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *captureHandler) Handle(_ context.Context, r slog.Record) error {
	r.Attrs(func(a slog.Attr) bool {
		if a.Value.Kind() == slog.KindString {
			h.attrs[a.Key] = a.Value.String()
		}
		return true
	})
	return nil
}

func (h *captureHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *captureHandler) WithGroup(string) slog.Handler      { return h }

// mutableString builds a string that aliases the given byte slice without copying,
// mimicking how fasthttp/Fiber hand back zero-copy views over their request buffer.
func mutableString(b []byte) string {
	return unsafe.String(&b[0], len(b))
}

// TestFanoutHandle_DetachesAliasedStrings is the regression test for the corrupted
// Sentry strings. A downstream handler that serializes asynchronously (captured here
// by reading the attr only AFTER the source buffer is mutated) must still see the
// original value, proving fanout.Handle copied it out of the caller's buffer.
func TestFanoutHandle_DetachesAliasedStrings(t *testing.T) {
	cap := &captureHandler{attrs: map[string]string{}}
	f := newFanout(cap)

	// A request buffer the "next request" will recycle underneath us.
	buf := []byte("GET")
	r := slog.NewRecord(time.Time{}, slog.LevelWarn, "http request", 0)
	r.AddAttrs(slog.String("method", mutableString(buf)))

	require.NoError(t, f.Handle(context.Background(), r))

	// Simulate fasthttp reusing the buffer for the next request before the async
	// sentry handler would have serialized the record.
	copy(buf, []byte("PUT"))

	assert.Equal(t, "GET", cap.attrs["method"],
		"fanout must clone aliased strings so a later buffer reuse can't mutate the logged value")
}

// TestCloneAttrStrings_RecursesGroups verifies the clone reaches string leaves nested
// inside a group attr, and leaves non-string values untouched.
func TestCloneAttrStrings_RecursesGroups(t *testing.T) {
	buf := []byte("/api/v1/rounds")
	grp := slog.Group("req",
		slog.String("path", mutableString(buf)),
		slog.Int("status", 200),
	)

	cloned := cloneAttrStrings(grp)
	copy(buf, []byte("/xxxxxxxxxxxxx"))

	require.Equal(t, slog.KindGroup, cloned.Value.Kind())
	got := map[string]slog.Value{}
	for _, a := range cloned.Value.Group() {
		got[a.Key] = a.Value
	}
	assert.Equal(t, "/api/v1/rounds", got["path"].String())
	assert.Equal(t, int64(200), got["status"].Int64())
}
