// e2e/web/events.auth.spec.ts
// Authenticated regression for the Events tab (backlog item F5).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts). Navigating to the root should redirect an authenticated
// user to the Events tab; we assert its header actions render and that we did NOT land
// back on the sign-in screen — which together prove the session injection works.
import { test, expect } from "@playwright/test";

test("authenticated root lands on the Events tab", async ({ page }) => {
  await page.goto("/");

  // "Discover" and "Create" are header actions unique to the (authenticated) Events
  // screen. ("Events" itself also appears as a tab-bar label, so it's ambiguous.)
  // exact:true keeps "Create" from matching "Create Event" / "Created by …".
  await expect(page.getByText("Create", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Discover", { exact: true })).toBeVisible();

  // If the injected session were missing, the root would redirect to sign-in instead.
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
