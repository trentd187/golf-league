// e2e/web/friends.auth.spec.ts
// Authenticated regression for the Friends tab (backlog item F9).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts). Navigating to /friends should render the Friends
// screen — we assert its heading, the "Following" section, the "Find Players"
// shortcut, and that we were NOT bounced to sign-in.
import { test, expect } from "@playwright/test";

test("authenticated /friends shows the Friends screen with Find Players", async ({ page }) => {
  await page.goto("/friends");

  // "Friends" is both the screen heading and the tab-bar label, so scope to the
  // first match to avoid a strict-mode violation while still proving it rendered.
  await expect(page.getByText("Friends", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });

  // The "Following" section header and the "Find Players" shortcut render regardless
  // of whether the user follows anyone, so they're stable anchors for the screen.
  await expect(page.getByText("Following", { exact: true })).toBeVisible();
  await expect(page.getByText("Find Players", { exact: true })).toBeVisible();

  // If the injected session were missing, /friends would redirect to sign-in instead.
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
