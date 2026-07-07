// e2e/web/rounds-create.auth.spec.ts
// Authenticated regression for the round-creation form (backlog item F14).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts). Opening Create from the My Rounds tab should render
// the New Round form. Data-independent and NON-mutating: we assert the form chrome
// renders, then leave without submitting (no round is created).
import { test, expect } from "@playwright/test";

test("authenticated rounds/create opens the New Round form", async ({ page }) => {
  await page.goto("/rounds");

  // Confirm we're on the My Rounds screen (and not bounced to sign-in) before acting.
  await expect(page.getByText("My Rounds", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Open the creation form via the header Create affordance (the F14 path under test).
  await page.getByText("Create", { exact: true }).click();

  // The New Round form heading + its fields render regardless of data state. The
  // round-name placeholder is a unique, stable anchor; the submit button confirms the
  // full form mounted.
  await expect(page.getByText("New Round", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByPlaceholder("e.g. Saturday morning round"),
  ).toBeVisible();
  await expect(page.getByText("Create Round", { exact: true })).toBeVisible();

  // Leave without submitting — nothing is created. The injected session persists
  // (a missing session would have redirected to sign-in instead of the form).
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
