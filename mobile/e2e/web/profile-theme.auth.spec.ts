// e2e/web/profile-theme.auth.spec.ts
// Authenticated regression for the Profile tab theme control (backlog item F19).
// Runs in the chromium-auth project (injected QA session, see e2e/web/auth.setup.ts).
// Tapping a theme option must move the "selected" state to that option; the selected theme
// button renders a thicker border (NativeWind `border-2`) than the unselected ones, which is
// an observable, deployed-safe flip that doesn't depend on the exact themed surface colors.
// We flip Light↔Dark, assert the selection follows the tap, then restore the theme that was
// selected on entry so the QA user's persisted theme is left as found. Non-mutating server-side.
import { test, expect } from "@playwright/test";

// buttonBorder returns the border width (px) of the theme button carrying `label`: the first
// ancestor of that label's text node that actually has a border. The selected option uses
// `border-2` (thicker) and the rest `border`, so the selected button's value is the largest.
async function buttonBorder(
  page: import("@playwright/test").Page,
  label: string,
): Promise<number> {
  return page.evaluate((lbl) => {
    const leaf = Array.from(document.querySelectorAll("*")).find(
      (el) => el.children.length === 0 && el.textContent?.trim() === lbl,
    );
    let el: Element | null = leaf ?? null;
    while (el) {
      const bw = parseFloat(getComputedStyle(el).borderTopWidth || "0");
      if (bw > 0) return bw;
      el = el.parentElement;
    }
    return 0;
  }, label);
}

test("authenticated /profile theme control moves selection when a theme is tapped", async ({
  page,
}) => {
  await page.goto("/profile");

  const light = page.getByText("Light", { exact: true });
  const dark = page.getByText("Dark", { exact: true });
  await expect(light).toBeVisible({ timeout: 15_000 });
  await expect(dark).toBeVisible();

  // Remember which of the two was selected on entry (thicker border) so we can restore it.
  const darkSelectedOnEntry = (await buttonBorder(page, "Dark")) > (await buttonBorder(page, "Light"));

  // Tap Dark → Dark becomes the selected option (its border grows past Light's).
  await dark.click();
  await expect
    .poll(async () => (await buttonBorder(page, "Dark")) > (await buttonBorder(page, "Light")), {
      timeout: 10_000,
    })
    .toBe(true);

  // Tap Light → selection flips back to Light.
  await light.click();
  await expect
    .poll(async () => (await buttonBorder(page, "Light")) > (await buttonBorder(page, "Dark")), {
      timeout: 10_000,
    })
    .toBe(true);

  // Restore the entry theme (only Dark needs re-selecting; Light is already selected).
  if (darkSelectedOnEntry) await dark.click();

  // The session must survive the interaction (no redirect to sign-in).
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
