<!-- TEST_BACKLOG.md — Prioritized backlog of QA regression tests to add over time.
     The /qa skill grows the suite by exactly ONE backend + ONE frontend test per run,
     always taking the first unchecked item in each list, then runs the full suite to
     validate. See .claude/skills/qa/SKILL.md ("Grow the suite" step). -->

# QA Test Backlog

The `/qa` skill runs post-push regression tests against the live **Railway develop**
deployment. Every `/qa` run **grows the suite by one backend + one frontend test**: it
takes the first unchecked item from each list below, implements it, validates it against
live, checks it off (with date), and commits the new test to `develop`.

## Rules every new test must follow

- **Develop only.** Tests target the develop deployment, never `main`/production.
- **Backend mutations are self-cleaning.** Any flow that creates data must capture the new
  id, assert, then `DELETE` it in the **same `.hurl` file**. Where practical, end with a
  trailing `GET … → 404` proving cleanup. Develop must be left as it was found.
- **QA user is a normal `user`.** The QA test user has global role `user`, so:
  event / round / group / guest / team / score flows test the **success** path; admin-only
  routes (course / tee / hole CRUD, external import) are tested only on the **negative**
  path (non-admin → `403`).
- **Round flows need a seeded course.** Round-creation flows must first
  `GET /api/v1/courses`, capture a real `course_id` / `tee_id`, and use it (the QA user
  cannot create courses). If develop has no course with holes, the item is **blocked** —
  note it and move to the next unchecked item.
- **Frontend auth naming.** Specs that need a signed-in session are named `*.auth.spec.ts`
  (run by the `chromium-auth` Playwright project, which injects the QA user's Supabase
  session via `e2e/web/auth.setup.ts`). Public specs stay `*.spec.ts`.
- **One file per new test.** New backend tests are self-contained `backend/qa/<name>.hurl`
  files (each repeats the Supabase sign-in step from `authenticated.hurl`); new frontend
  tests are new spec files under `mobile/e2e/web/`.
- **Newly added test must pass before commit.** A failing *new* test is a test-authoring
  bug — fix it and re-run; never commit it red. A failing *pre-existing* test is a real
  regression — report it, do not mask it.

> **Bootstrap note (2026-06-19):** the first `/qa` run after this backlog was created
> intentionally implemented the two *flagship* items out of order — **B6** (self-cleaning
> CRUD) and **F5** (the first authenticated screen) — to stand up and validate the
> self-cleaning-mutation pattern and the Playwright session-injection helper. From here,
> runs proceed top-down through the remaining unchecked items.

---

## Backend (Hurl) — ordered safest → richest

- [ ] **B1** — Unauthenticated `GET /api/v1/me` with no token → **401**. (negative, no data)
- [ ] **B2** — Non-admin `POST /api/v1/courses` as the QA user → **403**. (negative, no data)
- [ ] **B3** — `GET /api/v1/users/me/scorecard-settings` → 200, returns a settings object. (read-only)
- [ ] **B4** — `GET /api/v1/users/following` → 200, JSON collection. (read-only)
- [ ] **B5** — `GET /api/v1/users?q=<self>` → 200, JSON collection. (read-only)
- [x] **B6** — Event lifecycle (self-cleaning): `POST /events` → 201 capture `id`; `GET /events/:id` → 200 assert name; `PATCH /events/:id {status:"cancelled"}` → 200; `DELETE /events/:id` → 204; `GET /events/:id` → 404. — `backend/qa/events_crud.hurl` (added 2026-06-19)
- [ ] **B7** — Eventless round (self-cleaning): capture `course_id`/`tee_id` from `GET /courses`; `POST /rounds` → 201 capture `id`; `GET /rounds/:id` → 200; `DELETE /rounds/:id` → 204.
- [ ] **B8** — Round + group + guest (self-cleaning): create round → `POST …/groups` → `POST …/groups/:gid/guests {name}` → `GET …/scorecard` shows the guest → `DELETE /rounds/:id`.
- [ ] **B9** — Score entry (self-cleaning): create round + group with self as player → `PUT …/handicap` → `PUT …/scores` → `GET …/scorecard` shows strokes → `DELETE /rounds/:id`.
- [ ] **B10** — Vegas/Best Ball teams (self-cleaning): create round with `scoring_format` → `POST …/teams` → `PUT …/teams/:tid/members` → `GET …/teams` → `DELETE /rounds/:id`.
- [ ] **B11** — Event membership (self-cleaning): create event → `GET …/members` (creator is organizer) → exercise `PATCH …/members/:uid/role` path → delete event.

## Frontend (Playwright) — ordered (public first, then authenticated)

- [ ] **F1** — `/terms` renders: "Terms of Service" heading, brand, back affordance. (public)
- [ ] **F2** — `/privacy` renders: "Privacy Policy" heading, brand. (public)
- [ ] **F3** — A bogus route renders the `+not-found` fallback. (public)
- [ ] **F4** — Sign-in invalid/empty email shows an inline error and does **not** navigate. Do **not** submit a valid email (that sends a real OTP). (public)
- [x] **F5** — `/(tabs)/events` after session injection shows the "Events" heading + "Create" button. — `mobile/e2e/web/events.auth.spec.ts` (added 2026-06-19, needs `auth.setup.ts`)
- [ ] **F6** — `/(tabs)/rounds` shows "My Rounds" + a section header or empty state. (auth)
- [ ] **F7** — `/(tabs)/profile` shows "Profile", "Sign Out", and a theme/score-position control (`testID`s exist). (auth)
- [ ] **F8** — `/(tabs)/courses` shows "Courses" + a search input that filters the list. (auth)
- [ ] **F9** — `/(tabs)/friends` shows "Friends" + "Find Players". (auth)
- [ ] **F10** — `/(tabs)/stats` renders the stats screen. (auth)
