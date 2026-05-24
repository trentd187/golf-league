// e2e/web/auth.spec.ts
// Regression tests for the sign-in screen.
// Verifies all interactive elements render correctly for unauthenticated users.
import { test, expect } from "@playwright/test";

test("sign-in screen renders key elements", async ({ page }) => {
  await page.goto("/sign-in");

  // Brand identity
  await expect(page.getByText("Golf Stuff In Here")).toBeVisible();
  await expect(
    page.getByText("Sign in or create an account to continue")
  ).toBeVisible();

  // Google OAuth button
  await expect(page.getByText("Continue with Google")).toBeVisible();

  // Email OTP flow
  await expect(page.getByPlaceholder("Email address")).toBeVisible();
  await expect(page.getByText("Continue with Email")).toBeVisible();

  // Legal links
  await expect(page.getByText("Terms of Service")).toBeVisible();
  await expect(page.getByText("Privacy Policy")).toBeVisible();
});

test("email input accepts text", async ({ page }) => {
  await page.goto("/sign-in");
  const emailInput = page.getByPlaceholder("Email address");
  await emailInput.fill("test@example.com");
  await expect(emailInput).toHaveValue("test@example.com");
});
