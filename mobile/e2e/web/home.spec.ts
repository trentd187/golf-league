// e2e/web/home.spec.ts
// Smoke tests for the app root. Unauthenticated users are redirected to the
// sign-in screen, so these tests verify the app boots without a JS crash.
import { test, expect } from "@playwright/test";

test("app root loads without error", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto("/");
  // Wait for React to hydrate — look for any rendered text content.
  await expect(page.locator("body")).not.toBeEmpty();

  // No uncaught JS errors on load.
  const fatalErrors = consoleErrors.filter(
    (e) => !e.includes("Warning:") && !e.includes("ResizeObserver")
  );
  expect(fatalErrors).toHaveLength(0);
});

test("unauthenticated root redirects to sign-in content", async ({ page }) => {
  await page.goto("/");
  // The sign-in screen is the expected landing for unauthenticated users.
  // Wait for either the brand text or the Google button to appear.
  await expect(
    page
      .getByText("Golf Stuff In Here")
      .or(page.getByText("Continue with Google"))
      .first()
  ).toBeVisible({ timeout: 10_000 });
});
