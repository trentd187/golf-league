// __tests__/utils/idempotency.test.ts
// Unit tests for the Idempotency-Key generator. The byte source is injected so the
// output UUID is deterministic and the version/variant bit-twiddling is assertable.

import { newIdempotencyKey } from "@/utils/idempotency";

// fill returns a GetRandomValues stub that writes a fixed byte pattern.
function fill(byte: number) {
  return (arr: Uint8Array) => {
    arr.fill(byte);
    return arr;
  };
}

describe("newIdempotencyKey", () => {
  it("produces a canonical 8-4-4-4-12 lower-case v4 UUID", () => {
    const key = newIdempotencyKey(fill(0xab));
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("sets the version nibble to 4 and the variant nibble to 8–b", () => {
    // All-zero bytes isolates the forced bits: byte6 → 0x40, byte8 → 0x80.
    const key = newIdempotencyKey(fill(0x00));
    expect(key).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("reflects the random bytes outside the reserved nibbles", () => {
    const key = newIdempotencyKey(fill(0xff));
    // byte6 0xff → 0x4f, byte8 0xff → 0xbf; all others stay ff.
    expect(key).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("defaults to the global crypto when no source is injected", () => {
    const key = newIdempotencyKey();
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
