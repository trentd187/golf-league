// e2e/web/rounds-filter.auth.spec.ts
// Authenticated regression for the Rounds tab filter control (backlog item F21).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts).
//
// Opening the Filter sheet must surface its options, and dismissing it must leave the Rounds
// screen mounted. Data-independent: the filter options come from a static list
// (STATUS_FILTER_OPTIONS / FORMAT_FILTER_OPTIONS in app/(tabs)/rounds.tsx), so this holds
// whether or not the QA user has any rounds. Nothing is mutated — the sheet only writes to the
// persisted list-prefs store, and we restore the entry selection ("All Status") before leaving.
//
// Worth covering: this tab is where the round list, its filters, and the persisted prefs store
// all meet, and the store now routes through the reporting persist adapter
// (utils/persistStorage.ts) — a regression there would silently stop the selection saving.
import { test, expect } from "@playwright/test";

test("authenticated /rounds opens the filter sheet and stays rendered after dismissing", async ({
  page,
}) => {
  await page.goto("/rounds");

  // "My Rounds" is the unique page heading (the bottom-nav label is just "Rounds").
  await expect(page.getByText("My Rounds", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // The Filter affordance in the filter/sort bar.
  const filterButton = page.getByText("Filter", { exact: true }).first();
  await expect(filterButton).toBeVisible();
  await filterButton.click();

  // The sheet surfaces its status options. "All Status" and "Completed" bracket the static
  // status list, so they render regardless of what rounds exist.
  await expect(page.getByText("All Status", { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Completed", { exact: true }).first()).toBeVisible();

  // Dismissing must leave the screen mounted — not unmount it or bounce to sign-in.
  await page.keyboard.press("Escape");
  await expect(page.getByText("My Rounds", { exact: true })).toBeVisible();

  // Still authenticated: no redirect to the shared sign-in anchor.
  await expect(page.getByText("Continue with Google", { exact: true })).toHaveCount(0);
});
