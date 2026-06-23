// e2e/web/stats.auth.spec.ts
// Authenticated regression for the Stats tab (backlog item F10).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts). Navigating to /stats should render the Stats screen —
// we assert its "My Stats" heading, the inner "Scores" tab, a period filter pill, and
// that we were NOT bounced to sign-in. These anchors render regardless of whether the
// QA user has any completed rounds (data-independent).
import { test, expect } from "@playwright/test";

test("authenticated /stats shows the My Stats screen with inner tabs and filters", async ({ page }) => {
  await page.goto("/stats");

  // "My Stats" is the unique page heading (the bottom-nav label is just "Stats").
  await expect(page.getByText("My Stats", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // The inner "Stats | Scores" tab bar and the "All Time" period pill render in every
  // data state (including the empty state), so they're stable anchors for the screen.
  await expect(page.getByText("Scores", { exact: true })).toBeVisible();
  await expect(page.getByText("All Time", { exact: true })).toBeVisible();

  // If the injected session were missing, /stats would redirect to sign-in instead.
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
