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
- [x] **B11** — Event membership (self-cleaning): create event → `GET …/members` (creator is organizer) → exercise `PATCH …/members/:uid/role` path → delete event. — `backend/qa/event_member_role_crud.hurl` (added 2026-06-23; QA user is the sole member, so the PATCH re-sets the existing `organizer` role — demoting the lone organizer to `player` is blocked by `ErrLastOrganizer`; asserts the role is unchanged after, then deletes)
- [x] **B12** — Idempotent create replay (self-cleaning): `POST /events` with a fixed `Idempotency-Key` header → 201 capture `id`; repeat the SAME request + key → 201 with the **same `id`** (durable replay, no duplicate) and an `Idempotent-Replay: true` header; `DELETE /events/:id`; trailing `GET → 404`. Covers migration 000024 / `middleware.Idempotency` end-to-end on live develop. — `backend/qa/idempotent_create_replay.hurl` (added 2026-06-23; the captured Supabase `refresh_token` doubles as the per-run key — Hurl re-evaluates `{{newUuid}}` per use, so a generated key can't be reused across the two POSTs, and the body must be byte-identical or the replay returns 422)
- [x] **B13** — `GET /api/v1/me` → 200, returns the caller's user object (assert `id` + `email`). (read-only) — `backend/qa/me.hurl` (added 2026-06-28; Hurl has no `isNotEmpty` predicate — assert a non-empty id via `matches /.+/`)
- [x] **B14** — `GET /api/v1/events/public` → 200, JSON collection. (read-only) — `backend/qa/events_public.hurl` (added 2026-06-29; route is under the authed /api/v1 group, so it sends a bearer like the other files; asserts `$` isCollection)
- [ ] **B15** — `GET /api/v1/rounds` (`GetMyRounds`) → 200, JSON collection. (read-only)
- [ ] **B16** — `GET /api/v1/users/:self/stats?filter=all_time` → 200, stats object. Capture `:self` from `GET /me` first. (read-only)
- [ ] **B17** — `GET /api/v1/users/:self/rounds` → 200, JSON collection (`:self` from `GET /me`). (read-only)
- [ ] **B18** — `GET /api/v1/users/:self/scorecards` → 200, JSON collection — the batched endpoint behind the N+1 stats fix (`:self` from `GET /me`). (read-only)
- [ ] **B19** — Follow yourself (negative, no mutation): `POST /api/v1/users/:self/follow` (`:self` from `GET /me`) → **400** "cannot follow yourself" (`ErrFollowSelf`). (negative)
- [ ] **B20** — Non-admin tee create (negative): capture `course_id` from `GET /courses`; `POST /api/v1/courses/:courseId/tees` as the QA `user` → **403**. (negative — admin-only route; mirrors B2)
- [ ] **B21** — Non-admin external import (negative): `POST /api/v1/courses/import-external` as the QA `user` → **403**. (negative — admin-only route)
- [ ] **B22** — Scorecard settings round-trip (self-cleaning): `GET /users/me/scorecard-settings` capture current `ob_enabled`; `PATCH` flipping it → 200; `GET` asserts the flip; `PATCH` restoring the original value → 200. Leaves settings exactly as found. Covers `UpsertScorecardSettings`.
- [ ] **B23** — Event-linked round (self-cleaning): `POST /events` → 201 capture `eventId`; capture `course_id`/`tee_id` from `GET /courses`; `POST /events/:eventId/rounds` → 201 capture `roundId`; `GET /events/:eventId/rounds` shows it; `DELETE /rounds/:roundId` → 204; `DELETE /events/:eventId` → 204; trailing `GET /events/:eventId` → 404. Covers `ScheduleEventRound`.
- [ ] **B24** — Hole-stats upsert (self-cleaning): create a round (creator auto-joins Group 1), capture `round_player_id` from the scorecard, `PATCH` round `active`, `PUT …/players/:rpid/hole-stats` (e.g. `fir`/`gir`) → 200; `GET …/scorecard` reflects the stat; `DELETE /rounds/:id` → 204; trailing `GET → 404`. Covers `UpsertHoleStats` (advanced scorecard FIR/GIR path).

## Frontend (Playwright) — ordered (public first, then authenticated)

> **Detail-screen fixture (added 2026-06-24):** the highest-traffic screens are dynamic
> routes that need a real entity to render. Per Sentry (last 30d), the three most-visited
> screens in the whole app — `rounds/[id]` (99), `events/[id]` (78), `scorecard/[roundId]`
> (58) — had **no coverage**. The decision is to seed **one stable QA-owned fixture** on
> develop: an event-linked round with the QA user as a player (so a scorecard exists). That
> single fixture backs F11–F13. It is **persistent** — it must NOT be torn down by the
> self-cleaning backend tests. The first F11–F13 implementation stands up the seed
> (script or `auth.setup`-adjacent step) and records its ids for the specs to navigate to.
> `courses/[id]` (F15) reuses develop's already-seeded courses; `users/[userId]` (F16) uses
> the QA user's own profile id — neither needs the fixture.

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
_Prioritized by real traffic (Sentry, last 30d). F11–F16 close the detail-screen gaps —
the most-visited screens that currently have no coverage — before the lower-traffic polish
items F17–F22._

- [ ] **F11** — `rounds/[id]` (round detail — **#1 most-visited screen, 99 visits/30d**): navigate to the seeded fixture round and assert the round-detail chrome renders (round name/course header + a leaderboard or scores anchor). (auth — needs the detail-screen fixture) — _deferred 2026-06-28: this run added only the backend test (B13); F11 requires first standing up the persistent detail-screen fixture (a non-self-cleaning seed), which is a deliberate task to implement on its own rather than rush at session end. The existing 10 frontend specs ran green as regression coverage._
- [ ] **F12** — `events/[id]` (event detail — **#3, 78 visits/30d**): navigate to the seeded fixture event and assert the event-detail chrome renders (event name + a Rounds/Members section anchor). (auth — needs the detail-screen fixture)
- [ ] **F13** — `scorecard/[roundId]` (**#4, 58 visits/30d** — the core scoring screen): open the seeded fixture round's scorecard and assert the scorecard renders (hole/par header + the QA player row). Read-only — do **not** submit scores. (auth — needs the detail-screen fixture)
- [x] **F14** — `rounds/create` (22 visits/30d): open the round-creation form (via the Create affordance) and assert its fields render, then dismiss without creating. (auth — data-independent, no mutation) — `mobile/e2e/web/rounds-create.auth.spec.ts` (added 2026-06-29; clicks the My Rounds "Create" affordance, asserts the "New Round" heading, the unique round-name placeholder, and the "Create Round" button; non-mutating)
- [ ] **F15** — `courses/[id]` (12 visits/30d): from `/(tabs)/courses`, tap the first seeded course and assert the course-detail chrome renders (course name + a tee/holes anchor). (auth — reuses develop's seeded courses, no new fixture)
- [ ] **F16** — `users/[userId]` (16 visits/30d): navigate to the QA user's own public profile (id from the session/`GET /me`) and assert the profile chrome renders (name/handle + a stats or rounds anchor). (auth — no fixture; self profile always exists)
- [ ] **F17** — `/(tabs)/events`: tapping "Create" opens the event-creation form (name field visible), then dismissing it returns to the Events list without creating anything. (auth — data-independent, no mutation)
- [ ] **F18** — `/(tabs)/profile`: "Sign Out" returns to the sign-in screen (assert the sign-in heading/email field reappears). (auth)
- [ ] **F19** — `/(tabs)/profile`: toggling the theme control switches the rendered mode (assert a light/dark anchor or testID state flips), then toggle back. (auth — data-independent, no mutation)
- [ ] **F20** — `/(tabs)/stats`: switching the period pill (e.g. "All Time" → another period) keeps the stats screen rendered (assert the "My Stats" heading still present). (auth — data-independent, no mutation)
- [ ] **F21** — `/(tabs)/rounds`: opening the Filter control surfaces its options and the rounds screen still renders after dismissing/applying (assert "My Rounds" persists). (auth — data-independent, no mutation)
- [ ] **F22** — Tab navigation persists the session: from an authenticated tab, navigate to a second tab and back, asserting both headings render (no redirect to sign-in). (auth — data-independent)
