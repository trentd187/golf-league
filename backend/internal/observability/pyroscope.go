// pyroscope.go initialises continuous CPU and memory profiling via the
// Grafana Pyroscope Go SDK. When the URL env vars are not set, Init returns
// (nil, nil) and profiling is simply disabled — no overhead at runtime.
package observability

import (
	"github.com/grafana/pyroscope-go"
)

// initPyroscope starts the Pyroscope profiler and returns it so the caller can
// call profiler.Stop() on shutdown. Returns (nil, nil) when any arg is empty.
func initPyroscope(url, user, apiKey, env string) (*pyroscope.Profiler, error) {
	if url == "" || user == "" || apiKey == "" {
		return nil, nil
	}

	profiler, err := pyroscope.Start(pyroscope.Config{
		ApplicationName:   "golf-league",
		ServerAddress:     url,
		BasicAuthUser:     user,
		BasicAuthPassword: apiKey,
		Tags:              map[string]string{"env": env},

		// Collect the five standard Go profile types.
		ProfileTypes: []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileAllocSpace,
			pyroscope.ProfileInuseObjects,
			pyroscope.ProfileInuseSpace,
		},
	})
	if err != nil {
		return nil, err
	}

	return profiler, nil
}
