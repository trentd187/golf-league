// e2e/web/profile-signout.auth.spec.ts
// Authenticated regression for the Profile tab Sign Out action (backlog item F18).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts). Tapping "Sign Out" and confirming should tear down the
// session and return to the sign-in screen. Data-independent and safe: signing out only
// affects THIS test's isolated browser context, never the stored user.json fixture.
import { test, expect } from "@playwright/test";

test("authenticated /profile Sign Out returns to the sign-in screen", async ({ page }) => {
  await page.goto("/profile");

  const signOut = page.getByText("Sign Out", { exact: true });
  await expect(signOut).toBeVisible({ timeout: 15_000 });

  // On web, handleSignOut asks for confirmation via window.confirm() (Alert.alert is a
  // no-op in react-native-web) — auto-accept it so performSignOut runs.
  page.once("dialog", (dialog) => void dialog.accept());
  await signOut.click();

  // performSignOut does router.replace("/sign-in"); the shared sign-in anchor used across
  // the other specs is the "Continue with Google" button. Its appearance proves the
  // session was torn down and we landed back on sign-in.
  await expect(page.getByText("Continue with Google")).toBeVisible({ timeout: 15_000 });
});
