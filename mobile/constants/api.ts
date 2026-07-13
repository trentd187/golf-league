// constants/api.ts
// Shared API constants for backend requests. Centralizing these here means there is one
// place to update them rather than hunting hardcoded strings.

// EXPO_PUBLIC_ variables are embedded in the client bundle at build time — never
// put secrets here. ?? falls back to localhost when the env var is not set.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080";

// LIVE_POLL_MS is the cadence for every "live" view — the scorecard, the round detail, and
// the event leaderboard. Polling is now the ONLY live-update mechanism: the live-score
// WebSocket was removed because it echoed each save back to the device that made it, and
// the resulting refetch reflowed the scorecard mid-tap and swallowed FIR/GIR presses (it
// also never once completed a handshake on the league's cellular network). 60s was already
// the socket's fallback floor and was, in practice, doing all the real work.
//
// Polling only runs while a screen is focused AND the app is foregrounded, so a phone in a
// pocket costs nothing. See mobile/docs/live-updates.md.
export const LIVE_POLL_MS = 60_000;
