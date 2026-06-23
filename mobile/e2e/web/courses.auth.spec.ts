// e2e/web/courses.auth.spec.ts
// Authenticated regression for the Courses tab (backlog item F8).
// Runs in the chromium-auth project, which injects the QA user's Supabase session
// (see e2e/web/auth.setup.ts). Navigating to /courses should render the Courses
// screen — we assert its heading, the search input, that typing a no-match query
// filters the list down to the empty state, and that we were NOT bounced to sign-in.
import { test, expect } from "@playwright/test";

test("authenticated /courses shows the Courses screen with a filtering search", async ({ page }) => {
  await page.goto("/courses");

  // "Courses" is both the screen heading and the tab-bar label, so scope to the
  // first match to avoid a strict-mode violation while still proving it rendered.
  await expect(page.getByText("Courses", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });

  // The search box renders regardless of data state. Match a substring of the
  // placeholder to avoid depending on the trailing ellipsis character.
  const search = page.getByPlaceholder("Search by name, city, or state");
  await expect(search).toBeVisible();

  // Typing a query that can't match any course filters the list down to the empty
  // state — proving the search actually drives the list (it queries the API by name).
  await search.fill("zzzqqq-no-such-course-123");
  await expect(page.getByText("No courses match your search.")).toBeVisible({
    timeout: 15_000,
  });

  // If the injected session were missing, /courses would redirect to sign-in instead.
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
