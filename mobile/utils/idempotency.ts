// utils/idempotency.ts
// Generates an RFC-4122 v4 UUID for use as the Idempotency-Key header on score saves.
// One key is minted per *logical* save and reused across savePut's internal retries,
// so when a cellular phantom save makes the client retry a write that already
// committed, the backend sees the same key twice and can record the replay (see
// backend/internal/middleware/idempotency.go).
//
// Uses the platform crypto.getRandomValues — polyfilled for React Native in
// utils/supabase.ts, native in Node/Jest — rather than expo-crypto, so the helper is
// dependency-free and unit-tested with an injected byte source.

// getRandomValuesFn is the byte source. Default reads the global crypto; tests inject
// a deterministic filler so the produced UUID is predictable.
type GetRandomValues = (arr: Uint8Array) => Uint8Array;

const defaultGetRandomValues: GetRandomValues = (arr) =>
  (globalThis.crypto as Crypto).getRandomValues(arr);

// newIdempotencyKey returns a lower-case canonical v4 UUID (8-4-4-4-12).
export function newIdempotencyKey(
  getRandomValues: GetRandomValues = defaultGetRandomValues,
): string {
  const bytes = new Uint8Array(16);
  getRandomValues(bytes);
  // RFC 4122 §4.4: force the version (4) and variant (10xx) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
