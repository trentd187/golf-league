// e2e/web/not-found.spec.ts
// Public regression: a URL that matches no route renders the app's themed +not-found
// fallback (app/+not-found.tsx — an intentionally blank themed View) instead of crashing
// or showing Expo Router's red "Unmatched Route" error. (Backlog F3)
import { test, expect } from "@playwright/test";

test("a bogus route renders the +not-found fallback without an error", async ({ page }) => {
  // SPA: the server returns the app shell (2xx) for any path; routing happens client-side.
  const resp = await page.goto("/this-route-does-not-exist-zzz", { waitUntil: "networkidle" });
  expect(resp?.status() ?? 200).toBeLessThan(400);

  // The app mounted and rendered — the body is present/visible.
  await expect(page.locator("body")).toBeVisible();

  // The blank fallback shows neither Expo Router's "Unmatched Route" error page nor the
  // sign-in CTA (proving the bogus path didn't crash or redirect to a known screen).
  await expect(page.getByText("Unmatched Route")).toHaveCount(0);
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
