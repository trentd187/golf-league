// e2e/web/tab-nav-session.auth.spec.ts
// Authenticated regression: tab navigation preserves the signed-in session (backlog item F22).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts).
//
// Navigating between tabs and back must keep the user authenticated — never bounce to sign-in.
// Data-independent: both headings are static chrome, so this holds regardless of what data the
// QA user has. Nothing is mutated.
//
// Worth covering: a session that survives the initial load but drops on client-side tab
// navigation (e.g. a token-refresh path that throws and clears auth state) would strand the
// user on the sign-in screen mid-session — exactly the kind of silent auth regression the
// hardened getToken()/session-restore paths exist to prevent. This asserts the round trip holds.
import { test, expect } from "@playwright/test";

test("authenticated tab navigation round-trips without dropping the session", async ({
  page,
}) => {
  // Start on Rounds. "My Rounds" is the unique page heading (the nav label is just "Rounds").
  await page.goto("/rounds");
  await expect(page.getByText("My Rounds", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Navigate to a second tab (Stats) via its route.
  await page.goto("/stats");
  await expect(page.getByText("My Stats", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Back to the first tab — the session must still be live, so the heading re-renders.
  await page.goto("/rounds");
  await expect(page.getByText("My Rounds", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Still authenticated across the round trip: no redirect to the shared sign-in anchor.
  await expect(page.getByText("Continue with Google", { exact: true })).toHaveCount(0);
});
