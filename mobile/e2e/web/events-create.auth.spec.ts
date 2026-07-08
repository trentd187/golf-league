// e2e/web/events-create.auth.spec.ts
// Authenticated regression for the event-creation form (backlog item F17).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts). Tapping Create on the Events tab should open the
// Create Event modal with its name field. Data-independent and NON-mutating: we assert
// the form chrome renders, then leave without submitting (no event is created).
import { test, expect } from "@playwright/test";

test("authenticated events tab Create opens the Create Event form", async ({ page }) => {
  await page.goto("/events");

  // The header "Create" affordance is present for any authenticated user — its presence
  // also confirms we weren't bounced to sign-in before acting.
  const create = page.getByText("Create", { exact: true });
  await expect(create).toBeVisible({ timeout: 15_000 });
  await create.click();

  // "Create Event" appears twice in the modal (heading + submit button), so anchor on the
  // required Name field's placeholder — unique and stable. The default event type is
  // "league", so that placeholder is what renders. Its visibility proves the modal opened.
  await expect(
    page.getByPlaceholder("e.g. Saturday Morning League"),
  ).toBeVisible({ timeout: 15_000 });
  // The heading confirms the Create Event modal specifically (first match = the title).
  await expect(page.getByText("Create Event", { exact: true }).first()).toBeVisible();

  // Leave without submitting — nothing is created. A missing session would have
  // redirected to sign-in instead of rendering the form.
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
