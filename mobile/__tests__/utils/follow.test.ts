// __tests__/utils/follow.test.ts
// Unit tests for followOrUnfollow (utils/follow.ts). savePut/savePost are injected so the
// branch is verified without a real network — the point is that each direction picks the
// correct instrumented helper with the right method/label.

import { followOrUnfollow } from "@/utils/follow";

describe("followOrUnfollow", () => {
  it("unfollow (following=true) routes through savePut as an idempotent DELETE", async () => {
    const savePutImpl = jest.fn().mockResolvedValue(undefined);
    const savePostImpl = jest.fn().mockResolvedValue(undefined);

    await followOrUnfollow({
      url: "https://api/users/u1/follow",
      token: "jwt",
      following: true,
      savePutImpl,
      savePostImpl,
    });

    expect(savePutImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api/users/u1/follow",
        token: "jwt",
        method: "DELETE",
        label: "unfollow",
      }),
    );
    expect(savePostImpl).not.toHaveBeenCalled();
  });

  it("follow (following=false) routes through savePost (durable-idempotency create)", async () => {
    const savePutImpl = jest.fn().mockResolvedValue(undefined);
    const savePostImpl = jest.fn().mockResolvedValue(undefined);

    await followOrUnfollow({
      url: "https://api/users/u1/follow",
      token: "jwt",
      following: false,
      savePutImpl,
      savePostImpl,
    });

    expect(savePostImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api/users/u1/follow",
        token: "jwt",
        label: "follow",
      }),
    );
    expect(savePutImpl).not.toHaveBeenCalled();
  });
});
