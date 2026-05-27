// playwright.config.ts
// Playwright configuration for web regression tests.
// Tests run against the deployed web app (PLAYWRIGHT_BASE_URL env var).
// Run via: pnpm e2e:web
// One-time browser install: pnpm exec playwright install chromium
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/web",
  // Fail the suite if any test is still running after 30 seconds.
  timeout: 30_000,
  // Retry once on CI to reduce flakiness from network variance.
  retries: process.env.CI ? 1 : 0,
  use: {
    // PLAYWRIGHT_BASE_URL must be set to the deployed web URL before running.
    // Example: https://your-app.railway.app
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
