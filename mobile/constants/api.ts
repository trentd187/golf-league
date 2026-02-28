// constants/api.ts
// Defines shared constants used when making API calls to the Golf League backend.
// Centralizing the API URL here means there's one place to update it if the address changes,
// rather than hunting down hardcoded strings scattered across the codebase.

// API_URL is the base URL for all backend API requests.
//
// process.env.EXPO_PUBLIC_API_URL is an Expo environment variable read from a .env file at build time.
// Variables prefixed with EXPO_PUBLIC_ are safe to embed in the client bundle — they are NOT secret.
// Never put private keys or passwords in EXPO_PUBLIC_ variables because they will be visible in the app.
//
// The ?? operator is the "nullish coalescing" operator: it returns the right-hand side
// ("http://localhost:8080") only if the left-hand side is null or undefined.
// This provides a sensible default so the app works out of the box in local development
// without needing a .env file.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8080";
