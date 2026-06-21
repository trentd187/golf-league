// __tests__/utils/roundReconcile.test.ts
// Unit tests for roundStatusReconciled() in utils/roundReconcile.ts — the pure read-back
// check that lets the start-round save suppress a false failure when the PATCH already
// landed server-side (a cellular phantom write).

import { roundStatusReconciled } from "@/utils/roundReconcile";

describe("roundStatusReconciled", () => {
  it("returns true when the read-back round already has the target status", () => {
    expect(roundStatusReconciled({ status: "active" }, "active")).toBe(true);
  });

  it("returns false when the status differs (start did not land)", () => {
    expect(roundStatusReconciled({ status: "scheduled" }, "active")).toBe(false);
  });

  it("returns false when the status is missing or null", () => {
    expect(roundStatusReconciled({}, "active")).toBe(false);
    expect(roundStatusReconciled({ status: null }, "active")).toBe(false);
  });

  it("returns false for a null or undefined round", () => {
    expect(roundStatusReconciled(null, "active")).toBe(false);
    expect(roundStatusReconciled(undefined, "active")).toBe(false);
  });
});
