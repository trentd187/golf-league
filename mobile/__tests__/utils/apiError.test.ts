// __tests__/utils/apiError.test.ts
// Tests for the read path's error type and its classifiers.
//
// Two behaviours matter downstream:
//   - isClientError decides what NOT to retry (a 4xx never heals).
//   - isAlreadyReported stops the QueryCache handler from filing a second Sentry event for a
//     failure apiGet already reported with an endpoint label and a connection snapshot.

import { ApiError, isClientError, isAlreadyReported } from "@/utils/apiError";

describe("ApiError", () => {
  it("carries the status, the reported flag, and the endpoint label", () => {
    const err = new ApiError("nope", { status: 403, reported: true, label: "scorecard" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ApiError");
    expect(err.message).toBe("nope");
    expect(err.status).toBe(403);
    expect(err.reported).toBe(true);
    expect(err.label).toBe("scorecard");
  });

  it("defaults to unreported with no status (a bare transport failure)", () => {
    const err = new ApiError("Network request failed");
    expect(err.status).toBeUndefined();
    expect(err.reported).toBe(false);
  });
});

describe("isClientError", () => {
  it("is true for a 4xx — a definitive server answer that will not heal on retry", () => {
    expect(isClientError(new ApiError("forbidden", { status: 403 }))).toBe(true);
    expect(isClientError(new ApiError("not found", { status: 404 }))).toBe(true);
    expect(isClientError(new ApiError("teapot", { status: 400 }))).toBe(true);
    expect(isClientError(new ApiError("edge", { status: 499 }))).toBe(true);
  });

  it("is false for a 5xx — a server fault may well succeed on the next attempt", () => {
    expect(isClientError(new ApiError("boom", { status: 500 }))).toBe(false);
    expect(isClientError(new ApiError("gateway", { status: 502 }))).toBe(false);
  });

  it("is false for a transport failure (no status) — exactly the case worth retrying", () => {
    expect(isClientError(new ApiError("Network request failed"))).toBe(false);
  });

  it("is false for anything that isn't an ApiError", () => {
    expect(isClientError(new Error("plain"))).toBe(false);
    expect(isClientError("a string")).toBe(false);
    expect(isClientError(undefined)).toBe(false);
    expect(isClientError(null)).toBe(false);
  });
});

describe("isAlreadyReported", () => {
  it("is true only for an ApiError the read path already sent to Sentry", () => {
    expect(isAlreadyReported(new ApiError("x", { reported: true }))).toBe(true);
    expect(isAlreadyReported(new ApiError("x", { reported: false }))).toBe(false);
    expect(isAlreadyReported(new ApiError("x"))).toBe(false);
    expect(isAlreadyReported(new Error("plain"))).toBe(false);
    expect(isAlreadyReported(null)).toBe(false);
  });
});
