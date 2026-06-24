// e2e/web/sign-in-invalid-email.spec.ts
// F4: submitting an invalid email on the sign-in screen surfaces an error and does
// NOT navigate away. The screen has no client-side format check — it calls Supabase's
// signInWithOtp directly, and any error is shown via showAlert → window.alert on web
// (title "Something went wrong"). An invalid-format address is rejected by Supabase
// without sending an OTP, so this is safe to run against live develop. (public)
import { test, expect } from "@playwright/test";

test("invalid email shows an error alert and stays on sign-in", async ({ page }) => {
  await page.goto("/sign-in");

  await page.getByPlaceholder("Email address").fill("notanemail");

  // window.alert surfaces as a Playwright dialog — capture it before triggering submit.
  const dialogPromise = page.waitForEvent("dialog");
  await page.getByText("Continue with Email").click();

  const dialog = await dialogPromise;
  // The "Something went wrong" prefix is our app's error title (stable), independent of
  // Supabase's exact wording.
  expect(dialog.message()).toContain("Something went wrong");
  await dialog.dismiss();

  // No navigation away from the sign-in screen, and no OTP step was entered.
  await expect(page).toHaveURL(/sign-in/);
  await expect(page.getByPlaceholder("Email address")).toBeVisible();
});
