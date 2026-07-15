// e2e/web/stats-period.auth.spec.ts
// Authenticated regression for the Stats tab period filter (backlog item F20).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts). Switching the top-level period pill ("All Time" → "Last 20")
// must keep the Stats screen rendered — the whole tab shouldn't unmount or bounce to sign-in
// when the client-side period filter changes (period switching filters in memory, never
// refetches). "Last 20" and "All Time" are always-present pills (first + last options), so
// this is data-independent — it holds whether or not the QA user has any completed rounds.
// We restore "All Time" at the end so the tab is left as found.
import { test, expect } from "@playwright/test";

test("authenticated /stats keeps the screen rendered when the period pill switches", async ({
  page,
}) => {
  await page.goto("/stats");

  // "My Stats" is the unique page heading (the bottom-nav label is just "Stats").
  await expect(page.getByText("My Stats", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Both period pills render in every data state (they bracket the filter list).
  const last20 = page.getByText("Last 20", { exact: true });
  const allTime = page.getByText("All Time", { exact: true });
  await expect(last20).toBeVisible();
  await expect(allTime).toBeVisible();

  // Switch the period → the screen must stay mounted (heading persists, no unmount/redirect).
  await last20.click();
  await expect(page.getByText("My Stats", { exact: true })).toBeVisible();

  // Restore the entry period so the tab is left as found.
  await allTime.click();
  await expect(page.getByText("My Stats", { exact: true })).toBeVisible();

  // If the injected session were lost mid-interaction, /stats would redirect to sign-in.
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
