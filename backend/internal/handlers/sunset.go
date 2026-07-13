// handlers/sunset.go
// Tombstone handlers for endpoints that have been removed but whose old clients are
// still in the wild. They answer with a definitive status so a stale build settles
// instead of retrying forever, and they log (sampled) so we can see when the last
// old build is gone and the tombstone itself can be deleted.
package handlers

import (
	"log/slog"
	"sync/atomic"

	"github.com/gofiber/fiber/v2"
)

// wsSunsetSampleEvery logs 1 in N hits. An old build re-dials the socket up to ~8 times
// a minute for every open scorecard, so logging every hit would flood Sentry with the
// very noise the WebSocket removal is meant to end. 1-in-50 is enough to answer the only
// question this log exists for: "are any old builds still out there?"
const wsSunsetSampleEvery = 50

// wsSunsetHits counts every hit (not just the logged ones) so the sampled line can report
// the true total. atomic because Fiber serves requests concurrently.
var wsSunsetHits atomic.Uint64

// WSSunset handles GET /api/v1/ws/rounds/:roundId, the retired live-score WebSocket.
//
// Live updates are polling-only now (the socket echoed every save back to the device that
// made it, and its refetch reflowed the scorecard mid-tap — see mobile/docs/live-updates.md).
// The route stays registered purely so builds already on players' phones get a definitive
// 410 instead of a 404: their reconnect loop reaches its give-up cap once and falls back to
// the 60s poll it always had, rather than storming. Delete this handler and its route once
// ws.sunset_hit goes quiet.
func WSSunset() fiber.Handler {
	return func(c *fiber.Ctx) error {
		total := wsSunsetHits.Add(1)
		if total%wsSunsetSampleEvery == 1 {
			slog.InfoContext(c.UserContext(), "Retired live-score WebSocket dialed by an old client",
				"event_type_label", "ws.sunset_hit",
				"round_id", c.Params("roundId"),
				"total_hits", total,
				"user_agent", c.Get("User-Agent"),
			)
		}
		return c.Status(fiber.StatusGone).JSON(fiber.Map{
			jsonKeyError: "live updates are no longer available; the app now polls",
		})
	}
}
