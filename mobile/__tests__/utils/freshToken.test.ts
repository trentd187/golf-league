// __tests__/utils/freshToken.test.ts
// Tests for getFreshAccessToken — the token resolver shared by useAuth().getToken and the
// save-retry core. Covers the three outcomes: a live token, an expected { error } (logged,
// null), and a thrown getSession (fatal Issue, null).

// @sentry/react-native is auto-mocked; reportAuthFailure is the real module so we assert on
// how it routes (Issue vs Log) by spying on it.
import * as sentry from "@/utils/sentry";
import { getFreshAccessToken } from "@/utils/freshToken";

// Supabase auth.getSession is a jest.fn() we drive per test.
jest.mock("@/utils/supabase", () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));

import { supabase } from "@/utils/supabase";

const mockGetSession = supabase.auth.getSession as jest.Mock;

describe("getFreshAccessToken", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the access token when the session is live", async () => {
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: "fresh-token" } },
      error: null,
    });

    await expect(getFreshAccessToken()).resolves.toBe("fresh-token");
  });

  it("returns null and logs (not Issue) when getSession returns an error", async () => {
    const spy = jest.spyOn(sentry, "reportAuthFailure");
    mockGetSession.mockResolvedValue({
      data: { session: null },
      error: new Error("refresh token expired"),
    });

    await expect(getFreshAccessToken()).resolves.toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.any(Error), { stage: "get_token" });
  });

  it("returns null and reports fatal when getSession throws", async () => {
    const spy = jest.spyOn(sentry, "reportAuthFailure");
    mockGetSession.mockRejectedValue(new Error("storage broken"));

    await expect(getFreshAccessToken()).resolves.toBeNull();
    expect(spy).toHaveBeenCalledWith(expect.any(Error), {
      stage: "get_token",
      fatal: true,
    });
  });

  it("returns null when there is no session (signed out)", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    await expect(getFreshAccessToken()).resolves.toBeNull();
  });
});
