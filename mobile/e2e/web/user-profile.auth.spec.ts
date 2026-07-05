// e2e/web/user-profile.auth.spec.ts
// Authenticated regression for the user profile screen users/[userId] (backlog item F16).
// Runs in the chromium-auth project (injected QA session, see e2e/web/auth.setup.ts).
//
// No fixture needed: the QA user's own profile always exists. Following the F15 pattern
// (navigate by an API-fetched id rather than tapping an unselectable list card), we resolve
// the caller's id from GET /me, read the display_name the screen itself renders from
// GET /users/:id, navigate straight to /users/<id>, and assert that name is on the page.
// Read-only — no mutation.
import { test, expect, type APIRequestContext } from "@playwright/test";

// Static process.env access (not process.env[name]) keeps expo/no-dynamic-env-var happy.
function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `user-profile.auth: missing env var ${name}. The /qa skill exports SUPABASE_URL, ` +
        `SUPABASE_PUBLISHABLE_KEY, QA_TEST_EMAIL and QA_TEST_PASSWORD from backend/qa/variables.env.`
    );
  }
  return value;
}

// Sign in to Supabase with the QA user's password (same grant the Hurl suite uses) and
// return the access token. We re-auth here rather than read the injected session because
// supabase-js's localStorage format (base64-prefixed / chunked) is awkward to parse.
async function getAccessToken(request: APIRequestContext): Promise<string> {
  const supabaseUrl = required(process.env.SUPABASE_URL, "SUPABASE_URL");
  const apikey = required(process.env.SUPABASE_PUBLISHABLE_KEY, "SUPABASE_PUBLISHABLE_KEY");
  const email = required(process.env.QA_TEST_EMAIL, "QA_TEST_EMAIL");
  const password = required(process.env.QA_TEST_PASSWORD, "QA_TEST_PASSWORD");

  const res = await request.post(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    headers: { apikey, "Content-Type": "application/json" },
    data: { email, password },
  });
  expect(res.ok(), `Supabase sign-in failed: ${res.status()}`).toBeTruthy();
  const token = (await res.json()).access_token as string | undefined;
  if (!token) throw new Error("Supabase returned no access_token");
  return token;
}

test("authenticated user profile screen renders for the QA user's own profile", async ({ page, request }) => {
  const token = await getAccessToken(request);
  const base = process.env.PLAYWRIGHT_BASE_URL;
  const authHeader = { Authorization: `Bearer ${token}` };

  // Resolve the caller's own id, then read the profile the screen renders from the same
  // endpoint it uses (GET /users/:id → UserProfileData). baseURL is the web origin whose
  // Caddy proxy forwards /api/* to the backend, so the bearer token authorizes the calls.
  const meRes = await request.get(`${base}/api/v1/me`, { headers: authHeader });
  expect(meRes.ok(), `GET /me failed: ${meRes.status()}`).toBeTruthy();
  const selfId = (await meRes.json()).id as string;
  expect(selfId, "GET /me returned no id").toBeTruthy();

  const profRes = await request.get(`${base}/api/v1/users/${selfId}`, { headers: authHeader });
  expect(profRes.ok(), `GET /users/:id failed: ${profRes.status()}`).toBeTruthy();
  const displayName = (await profRes.json()).display_name as string;
  expect(displayName, "profile has no display_name to anchor on").toBeTruthy();

  await page.goto(`/users/${selfId}`);

  // display_name renders twice (header + profile card), so scope to the first match.
  await expect(page.getByText(displayName).first()).toBeVisible({ timeout: 15_000 });

  // The "rounds"/"events" summary line always renders (0 when empty), a data-independent
  // structural anchor proving the profile card mounted rather than an error/empty screen.
  await expect(page.getByText(/rounds/).first()).toBeVisible();

  // If the injected session were missing, the screen would redirect to sign-in instead.
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
