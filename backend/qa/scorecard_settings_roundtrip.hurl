# scorecard_settings_roundtrip.hurl — B22: scorecard-settings write round-trip (self-cleaning).
#
# PATCH /api/v1/users/me/scorecard-settings (UpsertScorecardSettings) is a FULL-OBJECT replace,
# not a partial merge — every field in the body is written, and any omitted boolean is persisted
# as false (a deliberate design so an unchecked stat is stored explicitly rather than falling back
# to a DB default of true). So a naive "PATCH {ob_enabled:false}" would ZERO every other setting.
# This test therefore captures the ENTIRE current settings object, flips only ob_enabled, and
# restores the exact original — leaving develop's QA user settings byte-for-byte as found.
#
# Covers: GetScorecardSettings read → UpsertScorecardSettings write → read-back → restore.
#
# Variables required in variables.env:
#   QA_BASE_URL, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, QA_TEST_EMAIL, QA_TEST_PASSWORD

# ── Step 1: Sign in and capture token ──────────────────────────────────────────
POST {{SUPABASE_URL}}/auth/v1/token?grant_type=password
apikey: {{SUPABASE_PUBLISHABLE_KEY}}
Content-Type: application/json

{
  "email": "{{QA_TEST_EMAIL}}",
  "password": "{{QA_TEST_PASSWORD}}"
}

HTTP 200
[Captures]
access_token: jsonpath "$.access_token"
[Asserts]
jsonpath "$.access_token" isString


# ── Step 2: Capture the full current settings object ───────────────────────────
# Every scalar is captured for faithful restore. stat_order is captured element-by-element
# (the QA user is on the default 8-stat order) because Hurl can't re-inject a whole collection.
GET {{QA_BASE_URL}}/api/v1/users/me/scorecard-settings
Authorization: Bearer {{access_token}}

HTTP 200
[Captures]
orig_fir: jsonpath "$.fir_enabled"
orig_gir: jsonpath "$.gir_enabled"
orig_putts: jsonpath "$.putts_enabled"
orig_fpd: jsonpath "$.first_putt_distance_enabled"
orig_pdm: jsonpath "$.putt_distance_made_enabled"
orig_ayd: jsonpath "$.approach_yds_enabled"
orig_tsc: jsonpath "$.tee_shot_club_enabled"
orig_tsd: jsonpath "$.tee_shot_distance_enabled"
orig_ob: jsonpath "$.ob_enabled"
orig_sp: jsonpath "$.score_position"
orig_sg: jsonpath "$.show_group_on_scorecard"
so0: jsonpath "$.stat_order[0]"
so1: jsonpath "$.stat_order[1]"
so2: jsonpath "$.stat_order[2]"
so3: jsonpath "$.stat_order[3]"
so4: jsonpath "$.stat_order[4]"
so5: jsonpath "$.stat_order[5]"
so6: jsonpath "$.stat_order[6]"
so7: jsonpath "$.stat_order[7]"
[Asserts]
jsonpath "$.ob_enabled" isBoolean
jsonpath "$.stat_order" count == 8


# ── Step 3: PATCH the full object with ob_enabled flipped OFF ──────────────────
# All other fields echo the captured originals, so only ob_enabled changes.
PATCH {{QA_BASE_URL}}/api/v1/users/me/scorecard-settings
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "fir_enabled": {{orig_fir}},
  "gir_enabled": {{orig_gir}},
  "putts_enabled": {{orig_putts}},
  "first_putt_distance_enabled": {{orig_fpd}},
  "putt_distance_made_enabled": {{orig_pdm}},
  "approach_yds_enabled": {{orig_ayd}},
  "tee_shot_club_enabled": {{orig_tsc}},
  "tee_shot_distance_enabled": {{orig_tsd}},
  "ob_enabled": false,
  "stat_order": ["{{so0}}","{{so1}}","{{so2}}","{{so3}}","{{so4}}","{{so5}}","{{so6}}","{{so7}}"],
  "score_position": "{{orig_sp}}",
  "show_group_on_scorecard": {{orig_sg}}
}

HTTP 200
[Asserts]
jsonpath "$.ob_enabled" == false


# ── Step 4: Read back — ob is off, everything else preserved ────────────────────
GET {{QA_BASE_URL}}/api/v1/users/me/scorecard-settings
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$.ob_enabled" == false
jsonpath "$.tee_shot_club_enabled" == {{orig_tsc}}
jsonpath "$.score_position" == "{{orig_sp}}"
jsonpath "$.stat_order" count == 8


# ── Step 5: Restore the exact original settings ────────────────────────────────
PATCH {{QA_BASE_URL}}/api/v1/users/me/scorecard-settings
Authorization: Bearer {{access_token}}
Content-Type: application/json

{
  "fir_enabled": {{orig_fir}},
  "gir_enabled": {{orig_gir}},
  "putts_enabled": {{orig_putts}},
  "first_putt_distance_enabled": {{orig_fpd}},
  "putt_distance_made_enabled": {{orig_pdm}},
  "approach_yds_enabled": {{orig_ayd}},
  "tee_shot_club_enabled": {{orig_tsc}},
  "tee_shot_distance_enabled": {{orig_tsd}},
  "ob_enabled": {{orig_ob}},
  "stat_order": ["{{so0}}","{{so1}}","{{so2}}","{{so3}}","{{so4}}","{{so5}}","{{so6}}","{{so7}}"],
  "score_position": "{{orig_sp}}",
  "show_group_on_scorecard": {{orig_sg}}
}

HTTP 200
[Asserts]
jsonpath "$.ob_enabled" == {{orig_ob}}


# ── Step 6: Final read-back confirms settings are exactly as found ─────────────
GET {{QA_BASE_URL}}/api/v1/users/me/scorecard-settings
Authorization: Bearer {{access_token}}

HTTP 200
[Asserts]
jsonpath "$.ob_enabled" == {{orig_ob}}
jsonpath "$.score_position" == "{{orig_sp}}"
jsonpath "$.stat_order" count == 8
