// utils/follow.ts
// Shared follow/unfollow request helper. Both the user search screen and the user profile
// screen toggle following with the exact same branch, so it lives here (DRY) and stays
// unit-tested while those screens keep only a one-line call.
//
// The two directions are NOT symmetric on the wire:
//   - Unfollow is an idempotent DELETE → savePut (its core treats a 404 on a retry as
//     success, so a cellular phantom delete converges).
//   - Follow is a non-idempotent create (the backend returns "already following" on a
//     duplicate) on a durable-idempotency-wrapped route → savePost, whose retry replays the
//     original 2xx instead of surfacing that error after a lost ack.
//
// savePut/savePost are injectable so the branch is testable without a real network.

import { savePut, FOREGROUND_SAVE } from "@/utils/saveRequest";
import { savePost } from "@/utils/savePost";

export interface FollowOptions {
  url: string; // `${API_URL}/api/v1/users/:id/follow`
  token: string;
  following: boolean; // current state: true → this call UNfollows; false → follows
  savePutImpl?: typeof savePut;
  savePostImpl?: typeof savePost;
}

// followOrUnfollow issues the correct instrumented request for the current follow state.
export async function followOrUnfollow(opts: FollowOptions): Promise<void> {
  const put = opts.savePutImpl ?? savePut;
  const post = opts.savePostImpl ?? savePost;
  if (opts.following) {
    await put({
      url: opts.url,
      token: opts.token,
      method: "DELETE",
      body: undefined,
      label: "unfollow",
      retry: FOREGROUND_SAVE,
    });
  } else {
    await post({
      url: opts.url,
      token: opts.token,
      body: {},
      label: "follow",
    });
  }
}
