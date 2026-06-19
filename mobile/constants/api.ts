// constants/api.ts
// Shared API constants for backend requests. Centralizing the URL here means
// there is one place to update it rather than hunting hardcoded strings.

// EXPO_PUBLIC_ variables are embedded in the client bundle at build time — never
// put secrets here. ?? falls back to localhost when the env var is not set.
// The live-score WebSocket URL is derived from this by buildWsUrl() in
// utils/liveUpdates.ts (http→ws / https→wss), so there is one host to configure.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080";
