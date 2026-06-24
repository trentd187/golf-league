// e2e/web/rounds.auth.spec.ts
// Authenticated regression for the Rounds tab (backlog item F6).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts). Navigating to /rounds should render the My Rounds
// screen — we assert its heading + Create action, that the filter/sort controls
// render, and that we did NOT land back on the sign-in screen.
import { test, expect } from "@playwright/test";

test("authenticated /rounds shows the My Rounds screen", async ({ page }) => {
  await page.goto("/rounds");

  // "My Rounds" is the screen heading (the tab-bar label is just "Rounds"), so it
  // uniquely identifies the Rounds screen rather than the tab chrome.
  await expect(page.getByText("My Rounds", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // The header Create action is always present on the authenticated screen.
  await expect(page.getByText("Create", { exact: true })).toBeVisible();

  // The Filter + Sort bar renders regardless of data state (loading/empty/list).
  // "Filter" is the filter trigger label; its presence proves the new controls shipped.
  await expect(page.getByText("Filter", { exact: true })).toBeVisible();

  // If the injected session were missing, /rounds would redirect to sign-in instead.
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
