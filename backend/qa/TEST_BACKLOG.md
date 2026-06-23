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

- [x] **B1** — Unauthenticated `GET /api/v1/me` with no token → **401**. — `backend/qa/unauth_me.hurl` (added 2026-06-19)
- [x] **B2** — Non-admin `POST /api/v1/courses` as the QA user → **403**. — `backend/qa/non_admin_course_403.hurl` (added 2026-06-19)
- [x] **B3** — `GET /api/v1/users/me/scorecard-settings` → 200, returns a settings object. (read-only) — `backend/qa/scorecard_settings.hurl` (added 2026-06-21)
- [x] **B4** — `GET /api/v1/users/following` → 200, JSON collection. (read-only) — `backend/qa/following.hurl` (added 2026-06-21)
- [x] **B5** — `GET /api/v1/users?q=<self>` → 200, JSON collection. (read-only) — `backend/qa/users_search.hurl` (added 2026-06-22)
- [x] **B6** — Event lifecycle (self-cleaning): `POST /events` → 201 capture `id`; `GET /events/:id` → 200 assert name; `PATCH /events/:id {status:"cancelled"}` → 200; `DELETE /events/:id` → 204; `GET /events/:id` → 404. — `backend/qa/events_crud.hurl` (added 2026-06-19)
- [x] **B7** — Eventless round (self-cleaning): capture `course_id`/`tee_id` from `GET /courses`; `POST /rounds` → 201 capture `id`; `GET /rounds/:id` → 200; `DELETE /rounds/:id` → 204; trailing `GET → 404`. — `backend/qa/eventless_round_crud.hurl` (added 2026-06-22)
- [x] **B8** — Round + group + guest (self-cleaning): create round → `POST …/groups` → `POST …/groups/:gid/guests {name}` → `GET …/scorecard` shows the guest → `DELETE /rounds/:id`. — `backend/qa/round_group_guest_crud.hurl` (added 2026-06-22)
- [x] **B9** — Score entry (self-cleaning): create round (creator auto-joins Group 1) → capture `round_player_id` from the scorecard → `PATCH` round `active` → `PUT …/handicap` → `PUT …/scores` → `GET …/scorecard` shows the stroke → `DELETE /rounds/:id` → `GET → 404`. — `backend/qa/score_entry_crud.hurl` (added 2026-06-23; the creator is auto-added to Group 1, so adding self via `…/members` returns 409 — capture the existing player instead; round must be `active` before scores)
- [x] **B10** — Vegas/Best Ball teams (self-cleaning): create round with `scoring_format` → `POST …/teams` → `PUT …/teams/:tid/members` → `GET …/teams` → `DELETE /rounds/:id`. — `backend/qa/vegas_teams_crud.hurl` (added 2026-06-23; las_vegas round, assigns the lone auto-joined QA player — 1 member is valid since the cap is max-2; asserts the team + member via `GET …/teams`)
- [ ] **B11** — Event membership (self-cleaning): create event → `GET …/members` (creator is organizer) → exercise `PATCH …/members/:uid/role` path → delete event.
- [ ] **B12** — Idempotent create replay (self-cleaning): `POST /events` with a fixed `Idempotency-Key` header → 201 capture `id`; repeat the SAME request + key → 201 with the **same `id`** (durable replay, no duplicate) and an `Idempotent-Replay: true` header; `DELETE /events/:id`; trailing `GET → 404`. Covers migration 000024 / `middleware.Idempotency` end-to-end on live develop.

## Frontend (Playwright) — ordered (public first, then authenticated)

- [x] **F1** — `/terms` renders: "Terms of Service" heading, brand, back affordance. — `mobile/e2e/web/terms.spec.ts` (added 2026-06-19)
- [x] **F2** — `/privacy` renders: "Privacy Policy" heading, brand. — `mobile/e2e/web/privacy.spec.ts` (added 2026-06-19)
- [x] **F3** — A bogus route renders the `+not-found` fallback. (public) — `mobile/e2e/web/not-found.spec.ts` (added 2026-06-21)
- [x] **F4** — Sign-in invalid/empty email shows an error and does **not** navigate. Do **not** submit a valid email (that sends a real OTP). (public) — `mobile/e2e/web/sign-in-invalid-email.spec.ts` (added 2026-06-22; the screen has no client-side check — it surfaces Supabase's rejection via `window.alert` "Something went wrong", not an inline message)
- [x] **F5** — `/(tabs)/events` after session injection shows the "Events" heading + "Create" button. — `mobile/e2e/web/events.auth.spec.ts` (added 2026-06-19, needs `auth.setup.ts`)
- [x] **F6** — `/(tabs)/rounds` shows "My Rounds" + a section header or empty state. (auth) — `mobile/e2e/web/rounds.auth.spec.ts` (added 2026-06-21, also asserts the new Filter control)
- [x] **F7** — `/(tabs)/profile` shows "Profile", "Sign Out", and a theme/score-position control (`testID`s exist). (auth) — `mobile/e2e/web/profile.auth.spec.ts` (added 2026-06-22; scopes "Profile" to `.first()` since it's both heading + tab label, asserts `score-position-first` testID)
- [x] **F8** — `/(tabs)/courses` shows "Courses" + a search input that filters the list. (auth) — `mobile/e2e/web/courses.auth.spec.ts` (added 2026-06-22; types a no-match query and asserts the "No courses match your search." empty state)
- [x] **F9** — `/(tabs)/friends` shows "Friends" + "Find Players". (auth) — `mobile/e2e/web/friends.auth.spec.ts` (added 2026-06-23; scopes "Friends" to `.first()` since it's both heading + tab label, also asserts the "Following" section header)
- [x] **F10** — `/(tabs)/stats` renders the stats screen. (auth) — `mobile/e2e/web/stats.auth.spec.ts` (added 2026-06-23; asserts the "My Stats" heading, the inner "Scores" tab, and the "All Time" period pill — all data-independent anchors)
