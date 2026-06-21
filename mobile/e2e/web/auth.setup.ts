// e2e/web/auth.setup.ts
// Playwright "setup" project: produces an authenticated storage state so that
// *.auth.spec.ts tests run as the QA test user WITHOUT driving the OTP / Google
// sign-in UI (which can't be automated headlessly).
//
// How it works:
//   1. Sign in to Supabase with the QA user's email+password using an in-memory
//      supabase-js client. We let supabase-js itself serialize the session into its
//      own storage adapter, so whatever exact localStorage key/format this version
//      uses (flat JSON, "base64-" prefixed, chunked across keys, …) is reproduced
//      verbatim — no guessing at the wire format.
//   2. Replay those exact key/value pairs into the deployed web app's localStorage.
//   3. Snapshot the Playwright storage state for the chromium-auth project to reuse.
//
// Credentials come from the environment — the /qa skill exports them from
// backend/qa/variables.env before running Playwright: SUPABASE_URL,
// SUPABASE_PUBLISHABLE_KEY, QA_TEST_EMAIL, QA_TEST_PASSWORD. PLAYWRIGHT_BASE_URL is
// the deployed web origin (already required by the suite, set in playwright.config.ts).
import { test as setup, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// Relative to the Playwright cwd (mobile/) — matches `storageState` in playwright.config.ts.
const AUTH_FILE = "e2e/.auth/user.json";

// Fail loudly with an actionable message rather than producing an unauthenticated state.
// Static process.env.X access (not process.env[name]) keeps expo/no-dynamic-env-var happy.
function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `auth.setup: missing env var ${name}. The /qa skill exports SUPABASE_URL, ` +
        `SUPABASE_PUBLISHABLE_KEY, QA_TEST_EMAIL and QA_TEST_PASSWORD from ` +
        `backend/qa/variables.env before running Playwright.`
    );
  }
  return value;
}

setup("authenticate QA user", async ({ page }) => {
  const supabaseUrl = required(process.env.SUPABASE_URL, "SUPABASE_URL");
  const supabaseKey = required(
    process.env.SUPABASE_PUBLISHABLE_KEY,
    "SUPABASE_PUBLISHABLE_KEY"
  );
  const email = required(process.env.QA_TEST_EMAIL, "QA_TEST_EMAIL");
  const password = required(process.env.QA_TEST_PASSWORD, "QA_TEST_PASSWORD");

  // In-memory storage so supabase-js persists the session somewhere we can read back.
  const store: Record<string, string> = {};
  const client = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: false, // no background timers — keeps the worker process clean
      detectSessionInUrl: false,
      storage: {
        getItem: (key) => store[key] ?? null,
        setItem: (key, value) => {
          store[key] = value;
        },
        removeItem: (key) => {
          delete store[key];
        },
      },
    },
  });

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  expect(error, error?.message).toBeNull();
  expect(data.session, "Supabase returned no session for the QA user").not.toBeNull();

  const entries = Object.entries(store);
  expect(entries.length, "supabase-js persisted no session keys").toBeGreaterThan(0);

  // Replay the exact persisted keys into the deployed app's origin, then snapshot.
  // baseURL (PLAYWRIGHT_BASE_URL) makes "/" resolve to the deployed web origin.
  await page.goto("/");
  await page.evaluate((kv) => {
    for (const [key, value] of kv) window.localStorage.setItem(key, value);
  }, entries);

  await page.context().storageState({ path: AUTH_FILE });
});
