// e2e/web/profile.auth.spec.ts
// Authenticated regression for the Profile tab (backlog item F7).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts). Navigating to /profile should render the Profile
// screen — we assert its heading, the Score Position control (a stable testID), and
// the Sign Out action, and that we did NOT get bounced back to the sign-in screen.
import { test, expect } from "@playwright/test";

test("authenticated /profile shows the Profile screen", async ({ page }) => {
  await page.goto("/profile");

  // "Profile" is both the screen heading and the tab-bar label, so scope to the
  // first match to avoid a strict-mode violation while still proving it rendered.
  await expect(page.getByText("Profile", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });

  // The Score Position toggle has a stable testID and renders regardless of data
  // state (settings always merge with defaults), so it uniquely identifies the screen.
  await expect(page.getByTestId("score-position-first")).toBeVisible();

  // The destructive Sign Out action is always present on the authenticated screen.
  await expect(page.getByText("Sign Out", { exact: true })).toBeVisible();

  // If the injected session were missing, /profile would redirect to sign-in instead.
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
