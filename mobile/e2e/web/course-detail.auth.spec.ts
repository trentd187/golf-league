// e2e/web/course-detail.auth.spec.ts
// Authenticated regression for the course detail screen courses/[id] (backlog item F15).
// Runs in the chromium-auth project (injected QA session, see e2e/web/auth.setup.ts).
//
// The Courses list renders cards as plain RNW <div>s with no href/role/testID on the
// deployed build, so there is no stable selector to "tap the first card" — and a new
// testID can't be asserted until it ships. Instead we cover the actual gap (the detail
// screen) deployment-safely: sign in to the live API for a token, read a real course id
// from develop's already-seeded courses, navigate straight to /courses/<id>, and assert
// the detail chrome. Read-only — no mutation, no fixture.
import { test, expect, type APIRequestContext } from "@playwright/test";

// Static process.env access (not process.env[name]) keeps expo/no-dynamic-env-var happy.
function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(
      `course-detail.auth: missing env var ${name}. The /qa skill exports SUPABASE_URL, ` +
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

test("authenticated course detail screen renders for a seeded course", async ({ page, request }) => {
  const token = await getAccessToken(request);

  // Pull a real course id from develop's seeded courses. baseURL is the web origin, whose
  // Caddy proxy forwards /api/* to the backend, so the bearer token authorizes the call.
  const coursesRes = await request.get(`${process.env.PLAYWRIGHT_BASE_URL}/api/v1/courses`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(coursesRes.ok(), `GET /courses failed: ${coursesRes.status()}`).toBeTruthy();
  const courses = (await coursesRes.json()) as { id: string }[];
  expect(courses.length, "develop has no seeded courses to open").toBeGreaterThan(0);

  await page.goto(`/courses/${courses[0].id}`);

  // "Tees" is the detail screen's section header and always renders (the header sits above
  // the "No tees configured yet." empty state even with zero tees). It is not on the list,
  // so it uniquely identifies the detail screen.
  await expect(page.getByText("Tees", { exact: true })).toBeVisible({ timeout: 15_000 });

  // The "<n>-hole course" line is detail-only and data-independent (hole_count is set at
  // creation), a second anchor proving the course header rendered.
  await expect(page.getByText(/\d+-hole course/)).toBeVisible();

  // If the injected session were missing, the screen would redirect to sign-in instead.
  await expect(page.getByText("Continue with Google")).toHaveCount(0);
});
