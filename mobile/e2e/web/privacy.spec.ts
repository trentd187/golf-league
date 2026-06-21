// e2e/web/privacy.spec.ts
// Public regression for the Privacy Policy screen (/privacy). Required by the app
// stores, so it must render for unauthenticated users with its heading, brand, and a
// back affordance. (Backlog F2)
import { test, expect } from "@playwright/test";

test("privacy screen renders heading, brand, and back affordance", async ({ page }) => {
  await page.goto("/privacy");

  // Screen heading — exact match avoids the body paragraphs that mention
  // "Privacy Policy" as a substring.
  await expect(page.getByText("Privacy Policy", { exact: true })).toBeVisible();

  // Brand identity — exact match; body paragraphs also name the app inline.
  await expect(page.getByText("Golf Stuff In Here", { exact: true })).toBeVisible();

  // Back affordance — the back button carries accessibilityLabel "Go back",
  // which maps to an aria-label on web.
  await expect(page.getByLabel("Go back")).toBeVisible();
});
