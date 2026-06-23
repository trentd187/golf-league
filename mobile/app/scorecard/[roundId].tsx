// app/scorecard/[roundId].tsx
// Scorecard screen for a single tee-time group within a round.
//
// Route: /scorecard/:roundId?groupId=<groupId>&groupNumber=<n>
// Navigate here from the round detail screen by tapping "Scorecard" on a group card.
//
// What it does:
//   1. Fetches GET /api/v1/rounds/:roundId/scorecard
//   2. Filters to the group matching the `groupId` search param
//   3. If the round requires handicaps and any player is missing one, shows a
//      handicap entry section at the top before score entry is available
//   4. Non-scramble formats: toggle between Basic view (all players in columns)
//      and Advanced view (one player at a time, hole-by-hole).
//      Both views share the same `scores` state — switching never discards data.
//   5. Allows any player in the group (or organizer/admin) to enter scores
//   6. Scores are auto-saved on blur via PUT /rounds/:id/players/:rpId/scores
//   7. Advanced view: hole-by-hole card with score entry + FIR/GIR/putts per hole,
//      navigated via hole selector pills or Prev/Next buttons.

import { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
} from "react-native";
// KeyboardAwareScrollView automatically lifts the focused input above the on-screen
// keyboard and only insets the bottom while the keyboard is up — replacing the old
// static paddingBottom + manual scrollToEnd glue. Requires <KeyboardProvider> at the
// app root (app/_layout.tsx). Native module: dev/preview build only, not Expo Go.
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useRoundLiveUpdates } from "@/hooks/useRoundLiveUpdates";
import { useUser } from "@/hooks/useUser";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import { girScoreFromPutts, girPuttsHint, puttDistanceMirror, holeRangeTotal, numericStatFocusNext, scoreFocusNext } from "@/utils/scorecard";
import type { Scorecard, ScorecardGroup, ScorecardHoleStat, ScorecardPlayer, ScorecardSettings, TeeShotClub } from "@/types/scorecard";
import { DEFAULT_SCORECARD_SETTINGS, TEE_SHOT_CLUBS } from "@/types/scorecard";
import { buildLiveVegasMatch, type VegasBasis } from "@/utils/vegas";
import VegasBasicScorecard from "@/components/VegasBasicScorecard";
import { buildLiveBestBallMatch, type BestBallBasis } from "@/utils/bestBall";
import { deriveFormatMatches, logFormatSummary } from "@/utils/formatTelemetry";
import BestBallBasicScorecard from "@/components/BestBallBasicScorecard";
import { showAlert } from "@/utils/alerts";
import { savePut, BACKGROUND_SAVE, FOREGROUND_SAVE } from "@/utils/saveRequest";
import {
  extractServerScores,
  scoresReconciled,
  extractServerHoleStat,
  holeStatReconciled,
} from "@/utils/saveReconcile";
import type { ComponentProps } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

// LocalScores maps round_player_id → hole_number → gross score string input.
// String rather than number so empty input fields stay blank.
type LocalScores = Record<string, Record<number, string>>;

// LocalHandicaps maps round_player_id → handicap string input.
type LocalHandicaps = Record<string, string>;

// HoleStatEntry holds the editable state for one hole's advanced stats.
// Putts and distances use strings so TextInput fields can be blank.
type HoleStatEntry = {
  gir: string | null;               // "hit" | "miss" | "na" | null
  gir_miss_direction: string | null; // "short" | "left" | "right" | "long" | null
  fir: boolean | null;
  fir_miss_direction: string | null;
  // fir_ob/gir_ob: additive out-of-bounds flags for the tee shot and approach.
  // Set independently of the directional pills (a shot can be both a direction and OB).
  fir_ob: boolean | null;
  gir_ob: boolean | null;
  putts: string;
  first_putt_distance: string; // feet
  putt_distance_made: string;  // feet
  approach_yds: string;        // yards; optional
  tee_shot_club: TeeShotClub | null;
  tee_shot_distance: string;   // yards
};

// NumericStatField is the subset of HoleStatEntry keys that are string fields
// rendered as TextInput number-pads in the stats section.
type NumericStatField = "putts" | "first_putt_distance" | "putt_distance_made" | "approach_yds" | "tee_shot_distance";

// LocalStats maps round_player_id → hole_number → HoleStatEntry.
type LocalStats = Record<string, Record<number, HoleStatEntry>>;

// IoniconsName is used to type the icon prop on stat option buttons.
type IoniconsName = ComponentProps<typeof Ionicons>["name"];

// GIR and FIR option descriptors — defined outside the component so they are
// not recreated on every render.
const GIR_OPTIONS: { key: string; label: string; icon: IoniconsName | null }[] = [
  { key: "hit",        label: "Hit",   icon: "checkmark"     },
  { key: "miss:short", label: "Short", icon: "arrow-down"    },
  { key: "miss:left",  label: "Left",  icon: "arrow-back"    },
  { key: "miss:right", label: "Right", icon: "arrow-forward" },
  { key: "miss:long",  label: "Long",  icon: "arrow-up"      },
  { key: "na",         label: "N/A",   icon: null            },
];

const FIR_OPTIONS: { key: string; label: string; icon: IoniconsName | null }[] = [
  { key: "hit",        label: "Hit",   icon: "checkmark"     },
  { key: "miss:short", label: "Short", icon: "arrow-down"    },
  { key: "miss:left",  label: "Left",  icon: "arrow-back"    },
  { key: "miss:right", label: "Right", icon: "arrow-forward" },
  { key: "miss:long",  label: "Long",  icon: "arrow-up"      },
];

// NUMERIC_STAT_META maps each numeric stat key to its display label and unit.
// Module-level so it isn't recreated on every render.
const NUMERIC_STAT_META: Record<NumericStatField, { label: string; unit: string | null }> = {
  putts:               { label: "Putts",       unit: null  },
  first_putt_distance: { label: "First Putt",  unit: "ft"  },
  putt_distance_made:  { label: "Made Putt",   unit: "ft"  },
  approach_yds:        { label: "Approach",    unit: "yds" },
  tee_shot_distance:   { label: "Drive Dist.", unit: "yds" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// initScores builds the initial LocalScores state from existing server scores.
function initScores(players: ScorecardPlayer[]): LocalScores {
  const out: LocalScores = {};
  for (const p of players) {
    out[p.round_player_id] = {};
    for (const s of p.scores) {
      out[p.round_player_id][s.hole_number] = String(s.gross_score);
    }
  }
  return out;
}

// initHandicaps builds the initial LocalHandicaps state from existing server data.
function initHandicaps(players: ScorecardPlayer[]): LocalHandicaps {
  const out: LocalHandicaps = {};
  for (const p of players) {
    out[p.round_player_id] = p.course_handicap != null ? String(p.course_handicap) : "";
  }
  return out;
}

// handicapStrokes returns the number of strokes a player receives on a hole.
// strokeIndex must be a normalized rank within the played set (1 = hardest).
// holeCount is the number of holes being played (9 or 18).
// Mirrors the Go HandicapStrokes function in services/handicap.go.
function handicapStrokes(courseHandicap: number, strokeIndex: number, holeCount: number): number {
  if (holeCount <= 0) return 0;
  const base = Math.floor(courseHandicap / holeCount);
  const remainder = courseHandicap % holeCount;
  return base + (strokeIndex <= remainder ? 1 : 0);
}

// initStats builds the initial LocalStats state from server-loaded hole_stats.
function initStats(players: ScorecardPlayer[]): LocalStats {
  const out: LocalStats = {};
  for (const p of players) {
    out[p.round_player_id] = {};
    for (const s of p.hole_stats) {
      out[p.round_player_id][s.hole_number] = {
        gir:                 s.gir,
        gir_miss_direction:  s.gir_miss_direction,
        fir:                 s.fir,
        fir_miss_direction:  s.fir_miss_direction,
        fir_ob:              s.fir_ob ?? null,
        gir_ob:              s.gir_ob ?? null,
        putts:               s.putts != null ? String(s.putts) : "",
        first_putt_distance: s.first_putt_distance != null ? String(s.first_putt_distance) : "",
        putt_distance_made:  s.putt_distance_made != null ? String(s.putt_distance_made) : "",
        approach_yds:        s.approach_yds != null ? String(s.approach_yds) : "",
        tee_shot_club:       s.tee_shot_club ?? null,
        tee_shot_distance:   s.tee_shot_distance != null ? String(s.tee_shot_distance) : "",
      };
    }
  }
  return out;
}

// girKey converts a HoleStatEntry's GIR fields into the compound key used by
// GIR_OPTIONS so the correct button can be highlighted.
function girKey(entry: HoleStatEntry | undefined): string | null {
  if (!entry?.gir) return null;
  if (entry.gir === "hit") return "hit";
  if (entry.gir === "na")  return "na";
  if (entry.gir === "miss" && entry.gir_miss_direction) return `miss:${entry.gir_miss_direction}`;
  return null;
}

// firKey converts a HoleStatEntry's FIR fields into the compound key used by
// FIR_OPTIONS so the correct button can be highlighted.
function firKey(entry: HoleStatEntry | undefined): string | null {
  if (entry?.fir === null || entry?.fir === undefined) return null;
  if (entry.fir === true) return "hit";
  if (entry.fir_miss_direction) return `miss:${entry.fir_miss_direction}`;
  return null;
}

// emptyHoleStat is the default state for a hole with no stats entered yet.
const emptyHoleStat: HoleStatEntry = {
  gir: null, gir_miss_direction: null,
  fir: null, fir_miss_direction: null,
  fir_ob: null, gir_ob: null,
  putts: "", first_putt_distance: "", putt_distance_made: "", approach_yds: "",
  tee_shot_club: null, tee_shot_distance: "",
};

// scoreColor returns a NativeWind class string for a score relative to par.
// Used in both Basic and Advanced views to keep color logic in one place.
function scoreColor(diff: number, textPrimary: string): string {
  if (diff <= -2) return "text-yellow-500"; // Eagle or better
  if (diff === -1) return "text-green-600"; // Birdie
  if (diff === 0)  return textPrimary;      // Par
  if (diff === 1)  return "text-blue-500";  // Bogey
  return "text-red-500";                    // Double+
}

// scoreToPar computes a player's cumulative score vs par for all holes played.
// Returns null when no holes have been scored yet.
// Holes with no par data (par === 0) are excluded from the par sum.
function scoreToPar(
  roundPlayerId: string,
  holeRows: { hole_number: number; par: number }[],
  localScores: LocalScores,
): number | null {
  const inputs = localScores[roundPlayerId] ?? {};
  let diff = 0, count = 0;
  for (const hole of holeRows) {
    const g = parseInt(inputs[hole.hole_number] ?? "", 10);
    if (!isNaN(g) && g >= 1 && hole.par) {
      diff += g - hole.par;
      count++;
    }
  }
  return count > 0 ? diff : null;
}

// formatToPar converts a numeric score differential to the standard display:
// "E" for even, "+N" for over, "-N" for under.
function formatToPar(diff: number): string {
  if (diff === 0) return "E";
  return diff > 0 ? `+${diff}` : String(diff);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScorecardScreen() {
  const { roundId } = useLocalSearchParams<{ roundId: string }>();
  // groupId and groupNumber come in as search (query) params.
  const { groupId, groupNumber } = useLocalSearchParams<{
    groupId: string;
    groupNumber: string;
  }>();
  const router        = useRouter();
  const { getToken }  = useAuth();
  const { user }      = useUser();
  const t             = useTheme();
  const queryClient   = useQueryClient();

  // Live score updates: a WebSocket pushes "scores_updated" → invalidate the scorecard
  // query so it refetches instantly. The 60s poll below stays as the floor, so this is a
  // pure latency win with no regression if the socket can't connect.
  useRoundLiveUpdates(roundId);

  // ── View mode ───────────────────────────────────────────────────────────────
  // "basic": all players shown in columns (always available).
  // "advanced": one player at a time, hole-by-hole with score + stats per hole.
  // The toggle is offered for every non-scramble round regardless of player count.
  // Switching never resets scores — both views share the same `scores` state.
  const [viewMode,         setViewMode]         = useState<"basic" | "advanced">("advanced");
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>("");

  // ── Score / handicap / UI state ─────────────────────────────────────────────
  const [scores,          setScores]          = useState<LocalScores>({});
  const [handicaps,         setHandicaps]         = useState<LocalHandicaps>({});
  const [savingHandicaps,   setSavingHandicaps]   = useState(false);
  // handicapDismissed: user tapped "Skip" in the handicap entry section.
  // Hides the section for the rest of the session even if handicaps are missing.
  const [handicapDismissed, setHandicapDismissed] = useState(false);
  // editingHandicapFor: round_player_id of the player whose handicap is being edited,
  // or null when not editing. Organizers can edit any player; others only themselves.
  const [editingHandicapFor, setEditingHandicapFor] = useState<string | null>(null);
  const [savingHandicap,     setSavingHandicap]     = useState(false);
  const [handicapDraft,      setHandicapDraft]      = useState("");
  // True for a round_player whose last score save failed; cleared on a later success.
  // Saves are otherwise optimistic — no in-progress or success indicator is shown.
  const [saveError,       setSaveError]       = useState<Record<string, boolean>>({});

  // ── Advanced stats + hole navigation state ───────────────────────────────────
  const [stats,          setStats]          = useState<LocalStats>({});
  // statsSaveError is set when all retries for a stats PUT are exhausted.
  const [statsSaveError, setStatsSaveError] = useState(false);
  // currentHole drives which hole is displayed in Advanced view (1-based).
  const [currentHole, setCurrentHole] = useState(1);

  // ── Fetch scorecard ─────────────────────────────────────────────────────────

  const fetchScorecard = useCallback(async (): Promise<Scorecard> => {
    const token = await getToken();
    const res = await apiFetch(`${API_URL}/api/v1/rounds/${roundId}/scorecard`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Failed to load scorecard");
    return res.json();
  }, [roundId, getToken]);

  const {
    data: scorecard,
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useQuery<Scorecard>({
    queryKey:       ["scorecard", roundId],
    queryFn:        fetchScorecard,
    enabled:        !!roundId,
    // Poll every minute so other players' scores stay in sync without requiring a manual refresh.
    // Average hole duration is ~13 min, so 60 s is frequent enough to catch updates mid-hole
    // without hammering the API.
    refetchInterval: 60_000,
  });

  // Fetch the user's stat visibility preferences. Shares the same cache key as the
  // profile screen so toggling a setting there is reflected here immediately.
  const { data: scorecardSettingsData } = useQuery<ScorecardSettings>({
    queryKey: ["scorecardSettings"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/users/me/scorecard-settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load scorecard settings");
      return res.json();
    },
    enabled: !!user,
  });

  const group: ScorecardGroup | undefined = scorecard?.groups.find(
    (g) => g.group_id === groupId
  );

  // ── Refs ────────────────────────────────────────────────────────────────────

  // scoresRef mirrors scores state so autoSavePlayer reads the latest value
  // without being recreated on every keystroke (avoids onBlur prop churn).
  const scoresRef  = useRef(scores);
  useEffect(() => { scoresRef.current = scores; }, [scores]);

  // statsRef mirrors stats state so autoSaveStats reads the latest value
  // without being recreated on every button tap or keystroke.
  const statsRef   = useRef(stats);
  useEffect(() => { statsRef.current = stats; }, [stats]);

  // saveTimers debounces per-player score saves.
  const saveTimers     = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // statSaveTimers debounces per-hole stat saves (key: "<rpId>-<holeNumber>").
  const statSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // inputRefs: Basic view grid — key "<holeIndex>-<playerIndex>".
  const inputRefs      = useRef<Map<string, TextInput | null>>(new Map());
  // statsInputRefs: Advanced view numeric stat fields, indexed by field position (0–3).
  const statsInputRefs = useRef<(TextInput | null)[]>([]);

  // scoreInputRef: Advanced view gross score field — used to chain keyboard focus
  // from the last numeric stat (score_position "last") or from the score field to the
  // first stat (score_position "first").
  const scoreInputRef = useRef<TextInput>(null);

  // currentHoleRef / lastHoleRef mirror their respective values so the
  // autoSavePlayer debounced callback can read them without being recreated
  // on every hole change (which would cause onBlur prop churn).
  const currentHoleRef = useRef(currentHole);
  useEffect(() => { currentHoleRef.current = currentHole; }, [currentHole]);

  // Tracks the last logged team-format completion signature so logFormatSummary
  // fires once per state transition (e.g. the match becoming fully scored) rather
  // than on every render. The ref is declared here at the top level (hook order is
  // stable); the guarded call lives below where the live match is computed.
  const lastFormatSigRef = useRef<string>("");

  const lastHoleRef = useRef<number>(18);
  useEffect(() => {
    if (!scorecard) return;
    const hCount = scorecard.hole_count ?? 18;
    const start  = scorecard.nine_hole_selection === "back" ? 10 : 1;
    lastHoleRef.current = start + hCount - 1;
  }, [scorecard]);

  // outerScrollRef: KeyboardAwareScrollView keeps the focused input visible on its
  // own, so this ref is only used to jump back to the top after the final hole saves
  // (see the last-hole scrollTo below). KeyboardAwareScrollView forwards a ScrollView
  // ref, so scrollTo works the same as on a plain ScrollView.
  const outerScrollRef = useRef<ScrollView>(null);

  // pillScrollRef: horizontal ScrollView holding the hole selector pills.
  // Scrolled automatically when currentHole changes so the active pill is
  // always centred in view without the user having to swipe manually.
  const pillScrollRef = useRef<ScrollView>(null);

  // holeChangeIsMount guards the hole-change refetch effect so it does not fire
  // on the initial mount. useQuery already fetches on mount — calling refetch()
  // simultaneously doubles the GET /scorecard request without adding any value.
  const holeChangeIsMount = useRef(true);

  // Scroll the hole pills so the active pill is always centred in view.
  // Each pill is w-9 (36px) with gap-2 (8px) between them = 44px per slot.
  // We subtract half the screen width and add half a pill so it lands centred.
  // For back-nine rounds currentHole starts at 10, so subtract startHole to get
  // the 0-based pill index before computing the scroll position.
  useEffect(() => {
    const PILL_STEP = 36 + 8; // w-9 + gap-2
    const screenW   = Dimensions.get("window").width;
    const pillIndex = currentHole - (scorecard?.nine_hole_selection === "back" ? 10 : 1);
    const x         = pillIndex * PILL_STEP - (screenW / 2) + 18;
    pillScrollRef.current?.scrollTo({ x: Math.max(0, x), animated: true });
  }, [currentHole, scorecard?.nine_hole_selection]);

  // Refetch when the player moves to a new hole so other players' freshly-saved
  // scores appear immediately rather than waiting for the next 60-second poll.
  // Skip the first fire — useQuery handles the initial fetch; a simultaneous
  // refetch() on mount doubles the GET /scorecard request for no gain.
  useEffect(() => {
    if (holeChangeIsMount.current) {
      holeChangeIsMount.current = false;
      return;
    }
    refetch();
  }, [currentHole, refetch]);


  // ── Auto-save ───────────────────────────────────────────────────────────────

  const autoSavePlayer = useCallback(
    (roundPlayerId: string) => {
      const existing = saveTimers.current.get(roundPlayerId);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(async () => {
        saveTimers.current.delete(roundPlayerId);
        const playerScores = scoresRef.current[roundPlayerId] ?? {};
        const entries = Object.entries(playerScores)
          .map(([holeStr, valStr]) => ({
            hole_number: parseInt(holeStr, 10),
            gross_score: parseInt(valStr, 10),
          }))
          .filter((e) => !isNaN(e.gross_score) && e.gross_score >= 1);

        if (entries.length === 0) return;

        try {
          const token = await getToken();
          // savePut applies the BACKGROUND_SAVE profile: per-attempt AbortController
          // timeout + Full-Jitter capped backoff (forces a fresh connection so a stale
          // okhttp socket can't fail every retry identically) + Sentry instrumentation.
          // Saves are optimistic, so nothing is shown unless every attempt fails.
          await savePut({
            url:   `${API_URL}/api/v1/rounds/${roundId}/players/${roundPlayerId}/scores`,
            token: token ?? "",
            body:  { scores: entries },
            label: "scores",
            retry: BACKGROUND_SAVE,
            // Phantom-save recovery: if every retry failed on the transport (cellular
            // ack lost), read the scorecard back and confirm the server already holds
            // exactly these scores. The PUT is an idempotent upsert, so a successful
            // commit with a dropped response is indistinguishable from this read.
            reconcile: async () => {
              const res = await fetch(
                `${API_URL}/api/v1/rounds/${roundId}/scorecard`,
                { headers: { Authorization: `Bearer ${token ?? ""}` } },
              );
              if (!res.ok) return false;
              const fresh = (await res.json()) as Scorecard;
              return scoresReconciled(entries, extractServerScores(fresh, roundPlayerId));
            },
          });
          // Clear any prior failure flag now that the save has succeeded.
          setSaveError((prev) => ({ ...prev, [roundPlayerId]: false }));
          // After saving the last hole, scroll back to the top so the user
          // sees the updated leaderboard without having to scroll manually.
          if (currentHoleRef.current === lastHoleRef.current) {
            outerScrollRef.current?.scrollTo({ y: 0, animated: true });
          }
        } catch {
          setSaveError((prev) => ({ ...prev, [roundPlayerId]: true }));
        }
      }, 400);

      saveTimers.current.set(roundPlayerId, timer);
    },
    [roundId, getToken]
  );

  // ── Advanced stats auto-save ─────────────────────────────────────────────────

  // autoSaveStats debounces a PUT /hole-stats call for a single hole.
  // Used for both button taps (0ms = feels instant) and text inputs (400ms).
  const autoSaveStats = useCallback(
    (roundPlayerId: string, holeNumber: number, delay = 300) => {
      const key = `${roundPlayerId}-${holeNumber}`;
      const existing = statSaveTimers.current.get(key);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(async () => {
        statSaveTimers.current.delete(key);
        const entry = statsRef.current[roundPlayerId]?.[holeNumber];
        if (!entry) return;

        // Convert string inputs to numbers, treating empty or invalid as null.
        const toInt = (v: string): number | null => {
          const n = parseInt(v, 10);
          return !isNaN(n) && n >= 0 ? n : null;
        };

        const stat = {
          hole_number:          holeNumber,
          gir:                  entry.gir,
          gir_miss_direction:   entry.gir_miss_direction,
          fir:                  entry.fir,
          fir_miss_direction:   entry.fir_miss_direction,
          fir_ob:               entry.fir_ob,
          gir_ob:               entry.gir_ob,
          putts:                toInt(entry.putts),
          first_putt_distance:  toInt(entry.first_putt_distance),
          putt_distance_made:   toInt(entry.putt_distance_made),
          approach_yds:         toInt(entry.approach_yds),
          tee_shot_club:        entry.tee_shot_club ?? null,
          tee_shot_distance:    toInt(entry.tee_shot_distance),
        };

        setStatsSaveError(false);
        try {
          const token = await getToken();
          // Same BACKGROUND_SAVE resilience as score saves; savePut throws on !res.ok
          // so HTTP errors are retried and reported, not silently swallowed.
          await savePut({
            url:   `${API_URL}/api/v1/rounds/${roundId}/players/${roundPlayerId}/hole-stats`,
            token: token ?? "",
            body:  { stats: [stat] },
            label: "hole-stats",
            retry: BACKGROUND_SAVE,
            // Phantom-save recovery (same as scores above): if every retry failed on
            // the transport, read the scorecard back and confirm the server already
            // holds exactly this hole's stat. PUT /hole-stats is an idempotent upsert,
            // so a committed write with a dropped ack is indistinguishable from this
            // read — without it, a cellular ack loss shows a false "Stats failed to save".
            reconcile: async () => {
              const res = await fetch(
                `${API_URL}/api/v1/rounds/${roundId}/scorecard`,
                { headers: { Authorization: `Bearer ${token ?? ""}` } },
              );
              if (!res.ok) return false;
              const fresh = (await res.json()) as Scorecard;
              return holeStatReconciled(
                stat as ScorecardHoleStat,
                extractServerHoleStat(fresh, roundPlayerId, holeNumber),
              );
            },
          });
          setStatsSaveError(false);
        } catch {
          setStatsSaveError(true);
        }
      }, delay);

      statSaveTimers.current.set(key, timer);
    },
    [roundId, getToken]
  );

  // ── Focus helpers ────────────────────────────────────────────────────────────

  // Basic view: advance to next player in the same hole, then wrap to next hole.
  const focusNext = useCallback(
    (holeIdx: number, playerIdx: number, totalPlayers: number, totalHoles: number) => {
      const nextPlayer = playerIdx + 1;
      if (nextPlayer < totalPlayers) {
        inputRefs.current.get(`${holeIdx}-${nextPlayer}`)?.focus();
      } else if (holeIdx + 1 < totalHoles) {
        inputRefs.current.get(`${holeIdx + 1}-0`)?.focus();
      }
    },
    []
  );

  // ── Initialisation ──────────────────────────────────────────────────────────

  const initializedRef = useRef(false);
  useEffect(() => {
    if (group && !initializedRef.current) {
      setScores(initScores(group.players));
      setHandicaps(initHandicaps(group.players));
      setStats(initStats(group.players));
      // Start on the first hole in play: hole 10 for back nine, hole 1 for everything else.
      setCurrentHole(scorecard?.nine_hole_selection === "back" ? 10 : 1);
      // Default Advanced view to the current user's player, then first player.
      // Use scorecard.caller_user_id (DB UUID) — it differs from the Supabase auth UUID.
      const myPlayer = group.players.find((p) => p.user_id === scorecard?.caller_user_id);
      setSelectedPlayerId(
        myPlayer?.round_player_id ?? group.players[0]?.round_player_id ?? ""
      );
      initializedRef.current = true;
    }
  }, [group]);

  // ── Handicap save ───────────────────────────────────────────────────────────

  const handleSaveHandicaps = async () => {
    if (!group) return;
    setSavingHandicaps(true);
    try {
      const token = await getToken();
      // FOREGROUND_SAVE: this is a visible save (spinner + disabled button), so a
      // shorter retry budget. savePut throws on !res.ok, fixing the previous silent
      // success-on-5xx (the raw fetch here never checked the response status).
      await Promise.all(
        group.players.map((player) => {
          const hStr = handicaps[player.round_player_id] ?? "";
          const hNum = parseInt(hStr, 10);
          if (isNaN(hNum)) return Promise.resolve();
          return savePut({
            url:   `${API_URL}/api/v1/rounds/${roundId}/players/${player.round_player_id}/handicap`,
            token: token ?? "",
            body:  { course_handicap: hNum },
            label: "handicap",
            retry: FOREGROUND_SAVE,
          });
        })
      );
      // Refetch directly so the scorecard data is fresh before the component re-renders —
      // invalidateQueries alone triggers a background refetch that may race with the
      // conditional display logic that depends on course_handicap being non-null.
      await refetch();
      queryClient.invalidateQueries({ queryKey: ["round", roundId] });
    } catch {
      showAlert("Error", "Could not save handicaps. Check your connection and try again.");
    } finally {
      setSavingHandicaps(false);
    }
  };

  // ── Handicap edit (post-entry correction — organizer: any player; others: own) ──

  const handleSaveHandicap = async () => {
    const targetId = editingHandicapFor;
    if (!targetId || !group) return;
    const hNum = Number.parseInt(handicapDraft, 10);
    if (Number.isNaN(hNum) || hNum < 0) {
      showAlert("Invalid", "Enter a valid course handicap (0 or more).");
      return;
    }
    setSavingHandicap(true);
    try {
      const token = await getToken();
      await savePut({
        url:   `${API_URL}/api/v1/rounds/${roundId}/players/${targetId}/handicap`,
        token: token ?? "",
        body:  { course_handicap: hNum },
        label: "handicap",
        retry: FOREGROUND_SAVE,
      });
      setEditingHandicapFor(null);
      // Refetch scorecard directly so net scores recalculate immediately.
      // Invalidate the round so the leaderboard reflects the updated handicap.
      await refetch();
      queryClient.invalidateQueries({ queryKey: ["round", roundId] });
    } catch {
      showAlert("Error", "Could not update handicap. Please try again.");
    } finally {
      setSavingHandicap(false);
    }
  };

  // ── Loading / error ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <View className={`flex-1 ${t.screen} items-center justify-center`}>
        <ActivityIndicator size="large" color={t.colors.tabBarActive} />
      </View>
    );
  }

  if (isError || !scorecard) {
    return (
      <View className={`flex-1 ${t.screen} items-center justify-center px-6 gap-4`}>
        <Ionicons name="alert-circle-outline" size={48} color="#dc2626" />
        <Text className={`text-base font-semibold text-center ${t.textPrimary}`}>
          Failed to load scorecard
        </Text>
        <TouchableOpacity className={`${t.primaryBg} rounded-xl px-6 py-3`} onPress={() => refetch()}>
          <Text className="text-white font-semibold">Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!group) {
    return (
      <View className={`flex-1 ${t.screen} items-center justify-center px-6`}>
        <Text className={`text-base text-center ${t.textSecondary}`}>Group not found.</Text>
      </View>
    );
  }

  // ── Derived state ───────────────────────────────────────────────────────────

  // Resolve stat visibility settings; fall back to defaults before the query resolves.
  const settings = scorecardSettingsData ?? DEFAULT_SCORECARD_SETTINGS;

  // Scramble: all players play from the same ball — the per-player Advanced view
  // doesn't apply, so the toggle is hidden and the Basic columns view is used.
  // Every other round shows the toggle regardless of how many players are in the group.
  const isScramble = scorecard.scoring_format === "scramble";
  const showToggle = !isScramble;

  // Resolve the selected player, falling back to the first player if stale.
  const selectedPlayer =
    group.players.find((p) => p.round_player_id === selectedPlayerId) ??
    group.players[0];

  // Only BLOCK score entry when the round explicitly requires a handicap.
  const needsHandicap = scorecard.requires_handicap &&
    group.players.some((p) => p.course_handicap == null);

  // Show the handicap section whenever any player is missing one — unless the
  // user has dismissed it for this session (they chose not to track handicaps).
  const showHandicapSection =
    !handicapDismissed && group.players.some((p) => p.course_handicap == null);

  // The current user's player entry in this group (undefined if they're not in this group).
  // Use scorecard.caller_user_id (DB UUID) — differs from the Supabase auth UUID in user?.id.
  const myPlayer = group.players.find((p) => p.user_id === scorecard.caller_user_id);

  // sortedPlayers puts the current user first so their column/pill always leads.
  const sortedPlayers = [...group.players].sort((a, b) => {
    if (a.user_id === scorecard.caller_user_id) return -1;
    if (b.user_id === scorecard.caller_user_id) return 1;
    return 0;
  });
  // visiblePlayers: when show_group_on_scorecard is off, both Advanced and Basic
  // views remain available but only the current user's data is shown in each.
  const visiblePlayers = settings.show_group_on_scorecard
    ? sortedPlayers
    : sortedPlayers.filter((p) => p.user_id === scorecard.caller_user_id);
  // canEditSelectedHandicap: show the C.H. edit affordance for the currently selected player.
  // Organizers can edit any player's handicap; regular players only their own.
  // Hidden while the initial handicap entry section is still visible.
  const canEditSelectedHandicap =
    scorecard.status === "active" &&
    selectedPlayer?.course_handicap != null &&
    !showHandicapSection &&
    (scorecard.is_organizer || selectedPlayerId === myPlayer?.round_player_id);

  // Non-organizers can only enter scores while the round is active. Organizers retain
  // full write access on scheduled and completed rounds for setup and corrections.
  const isRoundLocked = scorecard.status !== "active" && !scorecard.is_organizer;

  // canEditPlayer returns true when the current user is allowed to mutate scores/stats
  // for a given round_player_id. Organizers can edit anyone; regular players only themselves.
  const canEditPlayer = (roundPlayerId: string): boolean => {
    if (isRoundLocked) return false;
    if (scorecard.is_organizer) return true;
    return roundPlayerId === myPlayer?.round_player_id;
  };

  // Show Net column when the selected player has a handicap set.
  const showNetCol = selectedPlayer?.course_handicap != null;

  // Column widths for Basic view.
  const leftColW       = 38;
  const parColW        = 32;
  const siColW         = 32;
  const playerColW     = 64;

  const totalGroupWidth = leftColW + parColW + siColW + visiblePlayers.length * playerColW;

  // Build hole rows. Without tee data, generate placeholders with blank par/SI.
  // For back-nine rounds, startHole is 10 so holes are numbered 10–18.
  const holeCount = scorecard.hole_count || 18;
  const startHole = scorecard.nine_hole_selection === "back" ? 10 : 1;
  const lastHole  = startHole + holeCount - 1;
  type HoleRowData = { hole_number: number; par: number; stroke_index: number; yardage: number | null };
  const holeMap = new Map<number, HoleRowData>();
  for (const h of scorecard.holes) holeMap.set(h.hole_number, h);
  const holeRows: HoleRowData[] = Array.from({ length: holeCount }, (_, i) => {
    const n = startHole + i;
    return holeMap.get(n) ?? { hole_number: n, par: 0, stroke_index: 0, yardage: null };
  });

  // ── Las Vegas live match ──────────────────────────────────────────────────────
  // For a las_vegas round the Basic view is a combined team-vs-team matchup built
  // live from the local gross scores (so it updates as the user types). Computed
  // from the viewing player's perspective; null until the group has two teams.
  const isVegas = scorecard.scoring_format === "las_vegas";
  const vegasBasis: VegasBasis = scorecard.vegas_scoring_basis === "net" ? "net" : "gross";
  const vegasEffHandicaps: Record<string, number | null> = {};
  for (const p of group.players) vegasEffHandicaps[p.round_player_id] = p.effective_course_handicap;
  // Guard the live derivation: a math bug becomes a format-tagged Issue + a null
  // match (the Basic view falls back to its waiting state) instead of crashing the
  // active scorecard mid-round.
  const vegasMatch = isVegas
    ? deriveFormatMatches(
        { format: "las_vegas", derivation: "live_match", roundId: scorecard.round_id },
        () => buildLiveVegasMatch(group, holeRows, scores, vegasBasis, scorecard.vegas_birdie_flip, vegasEffHandicaps, myPlayer?.team_id ?? undefined),
        null,
      )
    : null;

  // ── Best Ball live match ──────────────────────────────────────────────────────
  // For a best_ball round the Basic view is the team leaderboard + per-hole best-ball
  // grid, built live from the local gross scores. Reuses the same effective-handicap
  // map; null until the group has at least two teams.
  const isBestBall = scorecard.scoring_format === "best_ball";
  const bestBallBasis: BestBallBasis = scorecard.best_ball_scoring_basis === "net" ? "net" : "gross";
  const bestBallMatch = isBestBall
    ? deriveFormatMatches(
        { format: "best_ball", derivation: "live_match", roundId: scorecard.round_id },
        () => buildLiveBestBallMatch(group, holeRows, scores, bestBallBasis, vegasEffHandicaps, myPlayer?.team_id ?? undefined),
        null,
      )
    : null;

  // Computed-result telemetry: emit one Sentry Logs line per completion-state change
  // of the active team-format match (ref-guarded so it does not fire every render).
  const activeFormatMatch = vegasMatch ?? bestBallMatch;
  if (activeFormatMatch) {
    const sig = `${scorecard.scoring_format}:${activeFormatMatch.complete}`;
    if (sig !== lastFormatSigRef.current) {
      lastFormatSigRef.current = sig;
      logFormatSummary({
        format: isVegas ? "las_vegas" : "best_ball",
        roundId: scorecard.round_id,
        groupCount: 1, // the scorecard renders a single playing group
        completeCount: activeFormatMatch.complete ? 1 : 0,
      });
    }
  }

  // Normalize stroke indexes to ranks 1–N within the played holes so that
  // 9-hole handicap previews distribute correctly (mirrors Go NormalizeStrokeIndexes).
  // holeRows is already filtered to the played set (front/back/full).
  const normalizedSIMap = new Map<number, number>();
  [...holeRows]
    .sort((a, b) => a.stroke_index - b.stroke_index)
    .forEach((h, rank) => normalizedSIMap.set(h.hole_number, rank + 1));
  const handicapHoleCount = holeRows.length || 18;

  // Pre-compute Advanced view running totals.
  let indivGrossTotal = 0, indivGrossCount = 0;
  let indivNetTotal   = 0, indivNetCount   = 0;
  if (selectedPlayer) {
    const indivInputs = scores[selectedPlayer.round_player_id] ?? {};
    for (const hole of holeRows) {
      const g = parseInt(indivInputs[hole.hole_number] ?? "", 10);
      if (!isNaN(g) && g >= 1) {
        indivGrossTotal += g;
        indivGrossCount++;
        if (showNetCol && selectedPlayer.effective_course_handicap != null && hole.stroke_index) {
          const nsi = normalizedSIMap.get(hole.hole_number) ?? 0;
          indivNetTotal += g - handicapStrokes(selectedPlayer.effective_course_handicap, nsi, handicapHoleCount);
          indivNetCount++;
        }
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <View className={`flex-1 ${t.screen}`}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <View className={`${t.surface} border-b ${t.divider} px-4 pt-14 pb-3 flex-row items-center gap-3`}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={t.colors.tabBarActive} />
        </TouchableOpacity>
        <View className="flex-1">
          <Text className={`text-lg font-bold ${t.textPrimary}`} numberOfLines={1}>
            {scorecard.round_name}
          </Text>
          <Text className={`text-xs ${t.textTertiary}`}>
            Group {groupNumber ?? group.group_number}
          </Text>
        </View>

        {/* Advanced / Basic toggle — non-scramble, 2+ players only */}
        {showToggle && (
          <View className={`flex-row rounded-lg overflow-hidden border ${t.border}`}>
            <TouchableOpacity
              onPress={() => setViewMode("advanced")}
              className={`px-3 py-1.5 ${viewMode === "advanced" ? "bg-green-700" : t.surface}`}
            >
              <Text className={`text-xs font-semibold ${viewMode === "advanced" ? "text-white" : t.textSecondary}`}>
                Advanced
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setViewMode("basic")}
              className={`px-3 py-1.5 ${viewMode === "basic" ? "bg-green-700" : t.surface}`}
            >
              <Text className={`text-xs font-semibold ${viewMode === "basic" ? "text-white" : t.textSecondary}`}>
                Basic
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <KeyboardAwareScrollView
        ref={outerScrollRef}
        className="flex-1"
        // Small resting pad only — KeyboardAwareScrollView adds the keyboard-sized
        // inset dynamically while the keyboard is up, then removes it (no permanent
        // whitespace). bottomOffset is the gap kept between the focused input and the
        // top of the keyboard.
        contentContainerStyle={{ paddingBottom: 24 }}
        bottomOffset={24}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={t.colors.tabBarActive}
          />
        }
        keyboardShouldPersistTaps="handled"
      >

        {/* ── Round completed notice ─────────────────────────────────────────── */}
        {isRoundLocked && (
          <View className="mx-4 mt-4 flex-row items-center gap-2 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3">
            <Ionicons name="lock-closed-outline" size={16} color="#d97706" />
            <Text className="flex-1 text-sm font-semibold text-amber-700">
              Round completed — scores are locked
            </Text>
          </View>
        )}

        {/* ── Handicap entry section ─────────────────────────────────────────── */}
        {/* Shows when any player is missing a handicap. Amber / blocking when the   */}
        {/* round requires it; neutral / optional otherwise (lets net scores appear). */}
        {showHandicapSection && (
          <View className={`mx-4 mt-4 rounded-2xl overflow-hidden border ${needsHandicap ? "border-amber-200" : t.border} ${t.surface}`}>
            <View className={`px-4 py-3 border-b ${needsHandicap ? "border-amber-200" : t.divider} flex-row items-center gap-2`}>
              <Ionicons
                name={needsHandicap ? "information-circle-outline" : "golf-outline"}
                size={16}
                color={needsHandicap ? "#d97706" : t.colors.tabBarInactive}
              />
              <Text className={`flex-1 text-sm font-semibold ${needsHandicap ? "text-amber-700" : t.textSecondary}`}>
                {needsHandicap ? "Course Handicap required to enter scores" : "Set Course Handicaps (optional)"}
              </Text>
              {/* Skip lets the user dismiss this section when they don't want to track handicaps */}
              <TouchableOpacity onPress={() => setHandicapDismissed(true)} hitSlop={8}>
                <Text className={`text-xs font-medium ${needsHandicap ? "text-amber-600" : t.textTertiary}`}>
                  Skip
                </Text>
              </TouchableOpacity>
            </View>
            <View className="px-4 py-3 gap-3">
              {group.players.map((player) => (
                <View key={player.round_player_id} className="flex-row items-center gap-3">
                  <View className="w-8 h-8 rounded-full bg-green-100 items-center justify-center flex-shrink-0">
                    <Text className="text-green-700 font-bold text-xs">
                      {player.display_name.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <Text className={`flex-1 text-sm font-semibold ${t.textPrimary}`} numberOfLines={1}>
                    {player.display_name}
                  </Text>
                  <TextInput
                    className={`w-16 border rounded-lg px-2 py-1.5 text-center text-sm ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                    placeholder="0"
                    placeholderTextColor={t.colors.tabBarInactive}
                    keyboardType="number-pad"
                    maxLength={2}
                    value={handicaps[player.round_player_id] ?? ""}
                    onChangeText={(v) =>
                      setHandicaps((prev) => ({ ...prev, [player.round_player_id]: v }))
                    }
                    editable={!savingHandicaps}
                  />
                </View>
              ))}
              <TouchableOpacity
                className={`rounded-xl py-3 items-center mt-1 ${savingHandicaps ? "bg-green-700/40" : "bg-green-700"}`}
                onPress={handleSaveHandicaps}
                disabled={savingHandicaps}
              >
                {savingHandicaps ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="text-white font-semibold text-sm">Set Course Handicaps</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}


        {/* ── Advanced view: player selector pills ───────────────────────────── */}
        {viewMode === "advanced" && (
          <View className="mt-4 gap-2">
            <View className="flex-row gap-2 px-4 flex-wrap">
              {visiblePlayers.map((p) => {
                const isSelected = selectedPlayerId === p.round_player_id;
                const isMe = p.user_id === scorecard.caller_user_id;
                return (
                  <TouchableOpacity
                    key={p.round_player_id}
                    onPress={() => setSelectedPlayerId(p.round_player_id)}
                    className={`flex-row items-center gap-1 px-3 py-1.5 rounded-full border ${
                      isSelected
                        ? "bg-green-700 border-green-700"
                        : isMe
                        ? `bg-green-700/10 border-green-700`
                        : `${t.surface} ${t.border}`
                    }`}
                  >
                    <Ionicons
                      name="person"
                      size={10}
                      color={isSelected ? "white" : isMe ? "#15803d" : "transparent"}
                      style={{ display: isMe ? "flex" : "none" }}
                    />
                    <Text
                      className={`text-sm font-semibold ${
                        isSelected ? "text-white" : isMe ? "text-green-700" : t.textPrimary
                      }`}
                      numberOfLines={1}
                    >
                      {(() => {
                        const diff = scoreToPar(p.round_player_id, holeRows, scores);
                        return `${p.display_name.split(" ")[0]} (${diff != null ? formatToPar(diff) : "-"})`;
                      })()}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              {/* C.H. chip — inline when ≤3 players and not currently editing */}
              {canEditSelectedHandicap && group.players.length <= 3 && editingHandicapFor !== selectedPlayerId && (
                <TouchableOpacity
                  className={`flex-row items-center gap-1 px-3 py-1.5 rounded-full border ${t.border} ${t.surface}`}
                  onPress={() => {
                    setHandicapDraft(String(selectedPlayer?.course_handicap ?? ""));
                    setEditingHandicapFor(selectedPlayerId);
                  }}
                  activeOpacity={0.7}
                >
                  <Text className={`text-sm font-semibold ${t.textSecondary}`}>
                    {scorecard.is_organizer && selectedPlayerId !== myPlayer?.round_player_id
                      ? `${selectedPlayer?.display_name.split(" ")[0]} C.H. ${selectedPlayer?.course_handicap}`
                      : `C.H. ${selectedPlayer?.course_handicap}`}
                  </Text>
                  <Ionicons name="pencil-outline" size={10} color={t.colors.tabBarInactive} />
                </TouchableOpacity>
              )}
            </View>
            {/* Edit row — shown below pills when ≤3 players and editing */}
            {canEditSelectedHandicap && group.players.length <= 3 && editingHandicapFor === selectedPlayerId && (
              <View className={`mx-4 flex-row items-center gap-2 px-3 py-2 rounded-xl border ${t.border} ${t.surface}`}>
                <Ionicons name="golf-outline" size={13} color={t.colors.tabBarInactive} />
                <Text className={`flex-1 text-xs ${t.textSecondary}`}>
                  {scorecard.is_organizer && selectedPlayerId !== myPlayer?.round_player_id
                    ? `${selectedPlayer?.display_name.split(" ")[0]} C.H.`
                    : "C.H."}
                </Text>
                <TextInput
                  className={`w-14 border rounded-lg px-2 py-1 text-center text-sm ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                  placeholder="0"
                  placeholderTextColor={t.colors.tabBarInactive}
                  keyboardType="number-pad"
                  maxLength={2}
                  value={handicapDraft}
                  onChangeText={setHandicapDraft}
                  editable={!savingHandicap}
                  autoFocus
                />
                <TouchableOpacity onPress={() => setEditingHandicapFor(null)} hitSlop={8} className="px-1">
                  <Text className={`text-xs ${t.textTertiary}`}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  className={`px-3 py-1 rounded-lg ${savingHandicap ? "bg-green-700/40" : "bg-green-700"}`}
                  onPress={handleSaveHandicap}
                  disabled={savingHandicap}
                >
                  {savingHandicap
                    ? <ActivityIndicator size="small" color="white" />
                    : <Text className="text-white text-xs font-semibold">Save</Text>
                  }
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* ── Scorecard tables ───────────────────────────────────────────────── */}

        {viewMode === "basic" && isVegas ? (

          /* ── Basic Vegas view: combined team-vs-team matchup ── */
          vegasMatch ? (
            <VegasBasicScorecard
              match={vegasMatch}
              holes={holeRows}
              scores={scores}
              onChangeScore={(rpId, hole, v) =>
                setScores((prev) => ({
                  ...prev,
                  [rpId]: { ...(prev[rpId] ?? {}), [hole]: v },
                }))
              }
              onBlurScore={(rpId) => autoSavePlayer(rpId)}
              canEdit={canEditPlayer}
              saveError={saveError}
              editableDisabled={savingHandicaps || needsHandicap}
            />
          ) : (
            <View className={`mt-6 items-center rounded-xl border ${t.border} ${t.surfaceSunken} p-6`}>
              <Ionicons name="people-outline" size={28} color={t.colors.tabBarInactive} />
              <Text className={`mt-2 text-sm font-semibold text-center ${t.textSecondary}`}>
                Waiting for opponents
              </Text>
              <Text className={`mt-1 text-xs text-center ${t.textTertiary}`}>
                This group needs two teams of two before the Vegas matchup can be scored.
                The organizer assigns teams from the round screen.
              </Text>
            </View>
          )

        ) : viewMode === "basic" && isBestBall ? (

          /* ── Basic Best Ball view: team leaderboard + per-hole best-ball grid ── */
          bestBallMatch ? (
            <BestBallBasicScorecard
              match={bestBallMatch}
              holes={holeRows}
              scores={scores}
              onChangeScore={(rpId, hole, v) =>
                setScores((prev) => ({
                  ...prev,
                  [rpId]: { ...(prev[rpId] ?? {}), [hole]: v },
                }))
              }
              onBlurScore={(rpId) => autoSavePlayer(rpId)}
              canEdit={canEditPlayer}
              saveError={saveError}
              editableDisabled={savingHandicaps || needsHandicap}
            />
          ) : (
            <View className={`mt-6 items-center rounded-xl border ${t.border} ${t.surfaceSunken} p-6`}>
              <Ionicons name="people-outline" size={28} color={t.colors.tabBarInactive} />
              <Text className={`mt-2 text-sm font-semibold text-center ${t.textSecondary}`}>
                Waiting for teams
              </Text>
              <Text className={`mt-1 text-xs text-center ${t.textTertiary}`}>
                This group needs at least two teams before Best Ball can be scored.
                The organizer assigns teams from the round screen.
              </Text>
            </View>
          )

        ) : viewMode === "basic" ? (

          /* ── Basic view: horizontal scroll, all players in columns ── */
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mt-4">
            <View style={{ width: totalGroupWidth }}>

              {/* Header row */}
              <View className={`flex-row items-center px-2 py-2 ${t.surfaceSunken} border-b ${t.divider}`}>
                <Text style={{ width: leftColW }} className={`text-xs font-bold text-center ${t.textTertiary}`}>H</Text>
                <Text style={{ width: parColW }}  className={`text-xs font-bold text-center ${t.textTertiary}`}>Par</Text>
                <Text style={{ width: siColW }}   className={`text-xs font-bold text-center ${t.textTertiary}`}>SI</Text>
                {visiblePlayers.map((p) => {
                  const hasSaveError = saveError[p.round_player_id] ?? false;
                  const isMe = p.user_id === scorecard.caller_user_id;
                  return (
                    <View
                      key={p.round_player_id}
                      style={{ width: playerColW }}
                      className={`items-center rounded-t-lg pb-0.5 ${isMe ? "bg-green-700/15 border-b-2 border-green-700" : ""}`}
                    >
                      <Text
                        className={`text-xs font-bold text-center ${isMe ? "text-green-700" : t.textPrimary}`}
                        numberOfLines={1}
                      >
                        {isMe ? `${p.display_name.split(" ")[0]} ★` : p.display_name.split(" ")[0]}
                      </Text>
                      {/* Score to par for this round; (-) when no holes played yet */}
                      {(() => {
                        const diff = scoreToPar(p.round_player_id, holeRows, scores);
                        return (
                          <Text className={`text-xs text-center ${t.textTertiary}`} numberOfLines={1}>
                            {diff != null ? formatToPar(diff) : "(-)"}
                          </Text>
                        );
                      })()}
                      {/* Failure-only indicator; a spacer keeps the column height stable otherwise. */}
                      {hasSaveError
                        ? <Ionicons name="alert-circle" size={10} color="#dc2626" />
                        : <View style={{ height: 10 }} />}
                    </View>
                  );
                })}
              </View>

              {/* Score rows — for 18-hole rounds an OUT subtotal row is inserted after hole 9 */}
              {holeRows.flatMap((hole, idx) => {
                const isOdd = idx % 2 === 0;
                const holeRow = (
                  <View
                    key={hole.hole_number}
                    className={`flex-row items-center px-2 py-1 border-b ${t.divider} ${isOdd ? t.surface : t.surfaceSunken}`}
                  >
                    <Text style={{ width: leftColW }} className={`text-sm font-semibold text-center ${t.textPrimary}`}>
                      {hole.hole_number}
                    </Text>
                    <Text style={{ width: parColW }} className={`text-xs text-center ${hole.par ? t.textSecondary : t.textTertiary}`}>
                      {hole.par || "—"}
                    </Text>
                    <Text style={{ width: siColW }} className={`text-xs text-center ${t.textTertiary}`}>
                      {hole.stroke_index || "—"}
                    </Text>
                    {visiblePlayers.map((player, playerIdx) => {
                      const val   = scores[player.round_player_id]?.[hole.hole_number] ?? "";
                      const gross = parseInt(val, 10);
                      const color = (hole.par && !isNaN(gross))
                        ? scoreColor(gross - hole.par, t.textPrimary)
                        : t.textPrimary;
                      const isLastCell =
                        idx === holeRows.length - 1 &&
                        playerIdx === visiblePlayers.length - 1;
                      return (
                        <View key={player.round_player_id} style={{ width: playerColW }} className="items-center px-1">
                          <TextInput
                            ref={(el) => { inputRefs.current.set(`${idx}-${playerIdx}`, el); }}
                            className={`w-full border rounded-lg text-center text-sm py-1 ${t.borderInput} ${t.surfaceSunken} ${color}`}
                            keyboardType="number-pad"
                            maxLength={2}
                            returnKeyType={isLastCell ? "done" : "next"}
                            value={val}
                            onChangeText={(v) =>
                              setScores((prev) => ({
                                ...prev,
                                [player.round_player_id]: {
                                  ...(prev[player.round_player_id] ?? {}),
                                  [hole.hole_number]: v,
                                },
                              }))
                            }
                            onSubmitEditing={() =>
                              focusNext(idx, playerIdx, visiblePlayers.length, holeRows.length)
                            }
                            onBlur={() => autoSavePlayer(player.round_player_id)}
                            editable={canEditPlayer(player.round_player_id) && !savingHandicaps && !needsHandicap}
                            placeholder="–"
                            placeholderTextColor={t.colors.tabBarInactive}
                          />
                        </View>
                      );
                    })}
                  </View>
                );

                if (hole.hole_number !== 9 || holeCount !== 18) return [holeRow];

                const outRow = (
                  <View key="out" className={`flex-row items-center px-2 py-1.5 border-b-2 ${t.border} ${t.surfaceSunken}`}>
                    <Text style={{ width: leftColW }} className={`text-xs font-bold text-center ${t.textTertiary}`}>OUT</Text>
                    <Text style={{ width: parColW }} className={`text-xs font-semibold text-center ${t.textSecondary}`}>
                      {holeRangeTotal(holeRows, {}, 1, 9).par || "—"}
                    </Text>
                    <View style={{ width: siColW }} />
                    {visiblePlayers.map((player) => {
                      const { score } = holeRangeTotal(holeRows, scores[player.round_player_id] ?? {}, 1, 9);
                      return (
                        <Text key={player.round_player_id} style={{ width: playerColW }} className={`text-sm font-semibold text-center ${t.textSecondary}`}>
                          {score != null ? score : "—"}
                        </Text>
                      );
                    })}
                  </View>
                );
                return [holeRow, outRow];
              })}

              {/* IN subtotal row for 18-hole rounds (back nine) */}
              {holeCount === 18 && (
                <View className={`flex-row items-center px-2 py-1.5 border-b ${t.divider} ${t.surfaceSunken}`}>
                  <Text style={{ width: leftColW }} className={`text-xs font-bold text-center ${t.textTertiary}`}>IN</Text>
                  <Text style={{ width: parColW }} className={`text-xs font-semibold text-center ${t.textSecondary}`}>
                    {holeRangeTotal(holeRows, {}, 10, 18).par || "—"}
                  </Text>
                  <View style={{ width: siColW }} />
                  {visiblePlayers.map((player) => {
                    const { score } = holeRangeTotal(holeRows, scores[player.round_player_id] ?? {}, 10, 18);
                    return (
                      <Text key={player.round_player_id} style={{ width: playerColW }} className={`text-sm font-semibold text-center ${t.textSecondary}`}>
                        {score != null ? score : "—"}
                      </Text>
                    );
                  })}
                </View>
              )}

              {/* Totals row */}
              <View className={`flex-row items-center px-2 py-2 ${t.surfaceSunken} border-t-2 ${t.border}`}>
                <Text style={{ width: leftColW }} className={`text-xs font-bold text-center ${t.textTertiary}`}>TOT</Text>
                <Text style={{ width: parColW }} className={`text-xs font-semibold text-center ${t.textSecondary}`}>
                  {scorecard.holes.reduce((sum, h) => sum + h.par, 0) || "—"}
                </Text>
                <View style={{ width: siColW }} />
                {visiblePlayers.map((player) => {
                  const playerInputs = scores[player.round_player_id] ?? {};
                  let total = 0, count = 0;
                  for (const v of Object.values(playerInputs)) {
                    const n = parseInt(v, 10);
                    if (!isNaN(n) && n >= 1) { total += n; count++; }
                  }
                  return (
                    <Text key={player.round_player_id} style={{ width: playerColW }} className={`text-sm font-bold text-center ${t.textPrimary}`}>
                      {count > 0 ? total : "—"}
                    </Text>
                  );
                })}
              </View>

            </View>
          </ScrollView>

        ) : (

          /* ── Advanced view: hole-by-hole entry ── */
          <View className="mt-4 px-4 gap-4">

            {/* Hole selector pills — green outline = score entered, solid green = current hole */}
            <ScrollView ref={pillScrollRef} horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2 py-1">
                {holeRows.map((hole) => {
                  const v        = scores[selectedPlayer?.round_player_id]?.[hole.hole_number] ?? "";
                  const hasScore = parseInt(v, 10) >= 1;
                  const isActive = currentHole === hole.hole_number;
                  return (
                    <TouchableOpacity
                      key={hole.hole_number}
                      onPress={() => setCurrentHole(hole.hole_number)}
                      className={`w-9 h-9 rounded-full items-center justify-center border ${
                        isActive   ? "bg-green-700 border-green-700"
                        : hasScore ? "border-green-700 bg-green-700/10"
                        :            `${t.surface} ${t.border}`
                      }`}
                    >
                      <Text className={`text-xs font-bold ${
                        isActive   ? "text-white"
                        : hasScore ? "text-green-700"
                        :            t.textPrimary
                      }`}>
                        {hole.hole_number}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>

            {/* Hole detail card — score + stats for the current hole */}
            {(() => {
              const rpId       = selectedPlayer.round_player_id;
              const holeData   = holeRows.find((h) => h.hole_number === currentHole) ?? holeRows[0];
              const val        = scores[rpId]?.[holeData.hole_number] ?? "";
              const gross      = parseInt(val, 10);
              // Use effective_course_handicap for net preview so the live display
              // matches what the server will store (allowance already applied).
              const hcp        = selectedPlayer.effective_course_handicap ?? null;
              const strokes    = (holeData.stroke_index && hcp != null)
                ? handicapStrokes(hcp, normalizedSIMap.get(holeData.hole_number) ?? 0, handicapHoleCount)
                : 0;
              const net        = (!isNaN(gross) && gross >= 1) ? gross - strokes : null;
              const grossClr   = (holeData.par && !isNaN(gross) && gross >= 1)
                ? scoreColor(gross - holeData.par, t.textPrimary)
                : t.textPrimary;
              const netClr     = (net != null && holeData.par)
                ? scoreColor(net - holeData.par, t.textPrimary)
                : t.textPrimary;
              const holeStat   = stats[rpId]?.[currentHole] ?? emptyHoleStat;
              const currentGir = girKey(holeStat);
              const currentFir = firKey(holeStat);

              // handleGIRTap toggles GIR. Tapping the active option clears it.
              // Auto-fill logic when GIR becomes "hit":
              //   - If putts is already set and score is blank: score = par - 2 + putts
              //     (GIR means reaching the green in par - 2 shots; add putts for final score)
              //   - If putts is blank but score is known: seed putts (birdie → 1, par → 2)
              const handleGIRTap = (key: string) => {
                const isActive = currentGir === key;
                let gir: string | null = null;
                let dir: string | null = null;
                if (!isActive) {
                  if (key === "hit")                { gir = "hit"; }
                  else if (key === "na")            { gir = "na"; }
                  else if (key.startsWith("miss:")) { gir = "miss"; dir = key.slice(5); }
                }
                if (gir === "hit" && holeData.par) {
                  const puttsNum = parseInt(holeStat.putts, 10);
                  if (!isNaN(puttsNum) && puttsNum >= 0 && val === "") {
                    // Putts already set, score blank → derive score from GIR regulation formula.
                    const autoScore = String(girScoreFromPutts(holeData.par, puttsNum));
                    setScores((prev) => ({
                      ...prev,
                      [rpId]: { ...(prev[rpId] ?? {}), [holeData.hole_number]: autoScore },
                    }));
                    autoSavePlayer(rpId);
                  }
                }
                const hintPutts = gir === "hit" && holeStat.putts === "" && holeData.par != null && !isNaN(gross)
                  ? girPuttsHint(holeData.par, gross)
                  : null;
                const autoPutts = hintPutts != null ? { putts: hintPutts } : {};
                setStats((prev) => ({
                  ...prev,
                  [rpId]: {
                    ...(prev[rpId] ?? {}),
                    [currentHole]: { ...(prev[rpId]?.[currentHole] ?? emptyHoleStat), gir, gir_miss_direction: dir, ...autoPutts },
                  },
                }));
                autoSaveStats(rpId, currentHole, 0);
              };

              // handleFIRTap toggles FIR. Tapping the active option clears it.
              const handleFIRTap = (key: string) => {
                const isActive = currentFir === key;
                let fir: boolean | null = null;
                let dir: string | null = null;
                if (!isActive) {
                  if (key === "hit")                { fir = true; }
                  else if (key.startsWith("miss:")) { fir = false; dir = key.slice(5); }
                }
                setStats((prev) => ({
                  ...prev,
                  [rpId]: {
                    ...(prev[rpId] ?? {}),
                    [currentHole]: { ...(prev[rpId]?.[currentHole] ?? emptyHoleStat), fir, fir_miss_direction: dir },
                  },
                }));
                autoSaveStats(rpId, currentHole, 0);
              };

              // handleOBTap toggles the additive OB flag for the tee shot (fir_ob) or
              // approach (gir_ob). Unlike the directional pills it does NOT clear the
              // sibling selection — a shot can be both a direction and OB. Tapping again
              // clears just the OB flag (true ⇄ null).
              const handleOBTap = (field: "fir_ob" | "gir_ob") => {
                setStats((prev) => {
                  const entry = prev[rpId]?.[currentHole] ?? emptyHoleStat;
                  return {
                    ...prev,
                    [rpId]: {
                      ...(prev[rpId] ?? {}),
                      [currentHole]: { ...entry, [field]: entry[field] === true ? null : true },
                    },
                  };
                });
                autoSaveStats(rpId, currentHole, 0);
              };

              // handleTeeShotClubTap toggles the selected tee shot club.
              // Tapping the already-selected club deselects it (sets to null).
              const handleTeeShotClubTap = (club: TeeShotClub) => {
                const isActive = holeStat.tee_shot_club === club;
                setStats((prev) => ({
                  ...prev,
                  [rpId]: {
                    ...(prev[rpId] ?? {}),
                    [currentHole]: {
                      ...(prev[rpId]?.[currentHole] ?? emptyHoleStat),
                      tee_shot_club: isActive ? null : club,
                    },
                  },
                }));
                autoSaveStats(rpId, currentHole, 0);
              };

              // Build ordered list of enabled numeric stats for keyboard focus chaining.
              // Derived from stat_order so focus-next follows the user's preferred order.
              const numericStatFields = settings.stat_order
                .filter((k): k is NumericStatField =>
                  k in NUMERIC_STAT_META &&
                  (settings[`${k}_enabled` as keyof ScorecardSettings] as boolean)
                )
                .map((k) => ({ field: k, ...NUMERIC_STAT_META[k] }));

              // renderScoreBlock renders the gross score input + net + HCP strokes row.
              // Defined as a closure so score_position can place it before or after stats
              // without prop drilling the many local variables it references.
              const renderScoreBlock = () => {
                // Determine whether pressing Enter on the score should chain to the first stat.
                const scoreNextTarget = scoreFocusNext(settings.score_position, numericStatFields.length);
                return (
                <View className={`flex-row items-center justify-center gap-8 px-4 py-5 border-t ${t.divider}`}>
                  <View className="items-center gap-1">
                    <Text className={`text-xs font-semibold uppercase tracking-wide ${t.textTertiary}`}>Score</Text>
                    <TextInput
                      ref={scoreInputRef}
                      className={`w-20 h-14 border-2 rounded-xl text-center text-3xl font-bold ${t.borderInput} ${t.surfaceSunken} ${grossClr}`}
                      keyboardType="number-pad"
                      maxLength={2}
                      // blurOnSubmit=false keeps the keyboard up when chaining to the
                      // first stat (score_position "first"); true lets Enter dismiss
                      // the keyboard when score is the last input.
                      blurOnSubmit={scoreNextTarget === null}
                      returnKeyType={scoreNextTarget !== null ? "next" : "done"}
                      onSubmitEditing={() => {
                        // KeyboardAwareScrollView keeps the focused field visible, so this
                        // only advances focus to the first stat when score is chained first.
                        if (scoreNextTarget !== null) {
                          statsInputRefs.current[scoreNextTarget]?.focus();
                        }
                      }}
                      value={val}
                      onChangeText={(v) => {
                        setScores((prev) => ({
                          ...prev,
                          [rpId]: { ...(prev[rpId] ?? {}), [holeData.hole_number]: v },
                        }));
                        // Auto-set putts when GIR is already "hit" and putts is blank:
                        // birdie → 1 putt, par → 2 putts.
                        const newGross = parseInt(v, 10);
                        if (
                          !isNaN(newGross) &&
                          holeData.par != null &&
                          currentGir === "hit" &&
                          holeStat.putts === ""
                        ) {
                          const autoP =
                            newGross === holeData.par - 1 ? "1"
                            : newGross === holeData.par   ? "2"
                            : null;
                          if (autoP !== null) {
                            setStats((prev) => ({
                              ...prev,
                              [rpId]: {
                                ...(prev[rpId] ?? {}),
                                [currentHole]: { ...(prev[rpId]?.[currentHole] ?? emptyHoleStat), putts: autoP },
                              },
                            }));
                            // Persist the auto-filled putt count — setStats alone won't save it.
                            autoSaveStats(rpId, currentHole, 400);
                          }
                        }
                      }}
                      onBlur={() => autoSavePlayer(rpId)}
                      editable={canEditSelected && !savingHandicaps && !needsHandicap}
                      placeholder="—"
                      placeholderTextColor={t.colors.tabBarInactive}
                    />
                  </View>
                  {showNetCol && (
                    <View className="items-center gap-1">
                      <Text className={`text-xs font-semibold uppercase tracking-wide ${t.textTertiary}`}>Net</Text>
                      <View className={`w-20 h-14 border-2 rounded-xl items-center justify-center ${t.border} ${t.surfaceSunken}`}>
                        <Text className={`text-3xl font-bold ${netClr}`}>{net != null ? net : "—"}</Text>
                      </View>
                    </View>
                  )}
                  {hcp != null && strokes > 0 && (
                    <View className="items-center gap-1">
                      {/* Show gross/effective handicaps when an allowance is active */}
                      <Text className={`text-xs font-semibold uppercase tracking-wide ${t.textTertiary}`}>
                        {scorecard.handicap_allowance != null &&
                         selectedPlayer.course_handicap !== hcp
                          ? `HCP ${selectedPlayer.course_handicap}→${hcp}`
                          : "HCP"}
                      </Text>
                      <View className={`w-16 h-14 border-2 rounded-xl items-center justify-center ${t.border} ${t.surfaceSunken}`}>
                        <Text className={`text-2xl font-bold ${t.textTertiary}`}>+{strokes}</Text>
                      </View>
                    </View>
                  )}
                </View>
                );
              };

              // Whether the current user can edit the displayed player's data.
              const canEditSelected = canEditPlayer(rpId);

              return (
                <View className={`rounded-2xl border ${t.border} ${t.surface} overflow-hidden`}>

                  {/* Hole info bar */}
                  <View className={`flex-row border-b ${t.divider} ${t.surfaceSunken}`}>
                    <View className="flex-1 items-center py-3">
                      <Text className={`text-xs ${t.textTertiary}`}>Hole</Text>
                      <Text className={`text-2xl font-bold ${t.textPrimary}`}>{holeData.hole_number}</Text>
                    </View>
                    <View className={`flex-1 items-center py-3 border-l ${t.border}`}>
                      <Text className={`text-xs ${t.textTertiary}`}>Par</Text>
                      <Text className={`text-2xl font-bold ${t.textPrimary}`}>{holeData.par || "—"}</Text>
                    </View>
                    <View className={`flex-1 items-center py-3 border-l ${t.border}`}>
                      <Text className={`text-xs ${t.textTertiary}`}>SI</Text>
                      <Text className={`text-2xl font-bold ${t.textPrimary}`}>{holeData.stroke_index || "—"}</Text>
                    </View>
                    {holeData.yardage != null && (
                      <View className={`flex-1 items-center py-3 border-l ${t.border}`}>
                        <Text className={`text-xs ${t.textTertiary}`}>Yards</Text>
                        <Text className={`text-2xl font-bold ${t.textPrimary}`}>{holeData.yardage}</Text>
                      </View>
                    )}
                  </View>

                  {/* Score entry — before stats when score_position is "first" */}
                  {settings.score_position === "first" && renderScoreBlock()}

                  {/* Stats rendered in user-defined order via stat_order */}
                  {settings.stat_order.map((statKey) => {
                    switch (statKey) {
                      case "fir":
                        return settings.fir_enabled ? (
                          <View key="fir" className={`px-4 py-3 gap-2 border-b ${t.divider} ${holeData.par === 3 ? "opacity-40" : ""}`}>
                            <Text className={`text-xs font-semibold uppercase tracking-wide ${t.textTertiary}`}>
                              Fairway in Regulation{holeData.par === 3 ? " (N/A — par 3)" : ""}
                            </Text>
                            <View className="flex-row flex-wrap gap-2">
                              {FIR_OPTIONS.map(({ key, label, icon }) => {
                                const active = currentFir === key;
                                return (
                                  <TouchableOpacity
                                    key={key}
                                    onPress={() => { if (holeData.par !== 3 && canEditSelected) handleFIRTap(key); }}
                                    className={`flex-row items-center gap-1 px-3 py-1.5 rounded-full border ${
                                      active ? "bg-green-700 border-green-700" : `${t.surface} ${t.border}`
                                    } ${!canEditSelected ? "opacity-50" : ""}`}
                                    activeOpacity={holeData.par === 3 || !canEditSelected ? 1 : 0.7}
                                  >
                                    {icon && (
                                      <Ionicons name={icon} size={12} color={active ? "white" : t.colors.tabBarActive} />
                                    )}
                                    <Text className={`text-xs font-semibold ${active ? "text-white" : t.textSecondary}`}>{label}</Text>
                                  </TouchableOpacity>
                                );
                              })}
                              {/* OB is additive — selectable alongside a directional pill (left AND OB). */}
                              {settings.ob_enabled && (
                                <>
                                  <View className={`w-px self-stretch border-l ${t.border} mx-1`} />
                                  <TouchableOpacity
                                    onPress={() => { if (holeData.par !== 3 && canEditSelected) handleOBTap("fir_ob"); }}
                                    className={`flex-row items-center gap-1 px-3 py-1.5 rounded-full border ${
                                      holeStat.fir_ob === true ? "bg-red-600 border-red-600" : `${t.surface} ${t.border}`
                                    } ${!canEditSelected ? "opacity-50" : ""}`}
                                    activeOpacity={holeData.par === 3 || !canEditSelected ? 1 : 0.7}
                                  >
                                    <Text className={`text-xs font-semibold ${holeStat.fir_ob === true ? "text-white" : t.textSecondary}`}>OB</Text>
                                  </TouchableOpacity>
                                </>
                              )}
                            </View>
                          </View>
                        ) : null;

                      case "gir":
                        return settings.gir_enabled ? (
                          <View key="gir" className={`px-4 py-3 gap-2 border-b ${t.divider}`}>
                            <Text className={`text-xs font-semibold uppercase tracking-wide ${t.textTertiary}`}>
                              Green in Regulation
                            </Text>
                            <View className="flex-row flex-wrap gap-2">
                              {GIR_OPTIONS.map(({ key, label, icon }) => {
                                const active = currentGir === key;
                                return (
                                  <TouchableOpacity
                                    key={key}
                                    onPress={() => { if (canEditSelected) handleGIRTap(key); }}
                                    className={`flex-row items-center gap-1 px-3 py-1.5 rounded-full border ${
                                      active ? "bg-green-700 border-green-700" : `${t.surface} ${t.border}`
                                    } ${!canEditSelected ? "opacity-50" : ""}`}
                                    activeOpacity={!canEditSelected ? 1 : 0.7}
                                  >
                                    {icon && (
                                      <Ionicons name={icon} size={12} color={active ? "white" : t.colors.tabBarActive} />
                                    )}
                                    <Text className={`text-xs font-semibold ${active ? "text-white" : t.textSecondary}`}>{label}</Text>
                                  </TouchableOpacity>
                                );
                              })}
                              {/* OB is additive — selectable alongside a directional/N-A pill. */}
                              {settings.ob_enabled && (
                                <>
                                  <View className={`w-px self-stretch border-l ${t.border} mx-1`} />
                                  <TouchableOpacity
                                    onPress={() => { if (canEditSelected) handleOBTap("gir_ob"); }}
                                    className={`flex-row items-center gap-1 px-3 py-1.5 rounded-full border ${
                                      holeStat.gir_ob === true ? "bg-red-600 border-red-600" : `${t.surface} ${t.border}`
                                    } ${!canEditSelected ? "opacity-50" : ""}`}
                                    activeOpacity={!canEditSelected ? 1 : 0.7}
                                  >
                                    <Text className={`text-xs font-semibold ${holeStat.gir_ob === true ? "text-white" : t.textSecondary}`}>OB</Text>
                                  </TouchableOpacity>
                                </>
                              )}
                            </View>
                          </View>
                        ) : null;

                      case "tee_shot_club":
                        return settings.tee_shot_club_enabled ? (
                          <View key="tee_shot_club" className={`px-4 py-3 gap-2 border-b ${t.divider}`}>
                            <Text className={`text-xs font-semibold uppercase tracking-wide ${t.textTertiary}`}>
                              Tee Shot Club
                            </Text>
                            <View className="flex-row flex-wrap gap-2">
                              {TEE_SHOT_CLUBS.map((club) => {
                                const active = holeStat.tee_shot_club === club;
                                return (
                                  <TouchableOpacity
                                    key={club}
                                    onPress={() => { if (canEditSelected) handleTeeShotClubTap(club); }}
                                    className={`px-3 py-1.5 rounded-full border ${
                                      active ? "bg-green-700 border-green-700" : `${t.surface} ${t.border}`
                                    } ${!canEditSelected ? "opacity-50" : ""}`}
                                    activeOpacity={!canEditSelected ? 1 : 0.7}
                                  >
                                    <Text className={`text-xs font-semibold ${active ? "text-white" : t.textSecondary}`}>{club}</Text>
                                  </TouchableOpacity>
                                );
                              })}
                            </View>
                          </View>
                        ) : null;

                      case "putts":
                      case "first_putt_distance":
                      case "putt_distance_made":
                      case "approach_yds":
                      case "tee_shot_distance": {
                        const field = statKey as NumericStatField;
                        if (!(settings[`${field}_enabled` as keyof ScorecardSettings] as boolean)) return null;
                        const numIdx   = numericStatFields.findIndex((f) => f.field === field);
                        const { label, unit } = NUMERIC_STAT_META[field];
                        // focusNext drives blurOnSubmit, returnKeyType, and onSubmitEditing
                        // so all three stay consistent from a single computation.
                        const focusNext = numericStatFocusNext(numIdx, numericStatFields.length, settings.score_position);
                        return (
                          <View key={field} className={`px-4 py-3 border-b ${t.divider}`}>
                            <View className="flex-row items-center justify-between">
                              <Text className={`text-sm ${t.textSecondary}`}>
                                {label}{unit ? ` (${unit})` : ""}
                              </Text>
                              <TextInput
                                ref={(el) => { statsInputRefs.current[numIdx] = el; }}
                                className={`w-20 border rounded-lg px-2 py-1.5 text-center text-sm ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                                keyboardType="number-pad"
                                maxLength={3}
                                placeholder="—"
                                placeholderTextColor={t.colors.tabBarInactive}
                                blurOnSubmit={focusNext === null}
                                returnKeyType={focusNext !== null ? "next" : "done"}
                                onSubmitEditing={() => {
                                  if (typeof focusNext === "number") {
                                    statsInputRefs.current[focusNext]?.focus();
                                  } else if (focusNext === "score") {
                                    scoreInputRef.current?.focus();
                                  }
                                }}
                                editable={canEditSelected}
                                value={holeStat[field] as string}
                                onChangeText={(v) => {
                                  setStats((prev) => {
                                    const current = prev[rpId]?.[currentHole] ?? emptyHoleStat;
                                    // When putts = 1, first putt and made putt distances are identical —
                                    // mirror whichever field the user types into the other.
                                    const extra = puttDistanceMirror(field, current.putts, v) as Partial<HoleStatEntry>;
                                    return {
                                      ...prev,
                                      [rpId]: {
                                        ...(prev[rpId] ?? {}),
                                        [currentHole]: { ...current, [field]: v, ...extra },
                                      },
                                    };
                                  });
                                  // When putts changes with GIR hit and par known, auto-fill score
                                  // if it's blank. Formula: score = par - 2 + putts (GIR regulation).
                                  if (field === "putts" && holeStat.gir === "hit" && holeData.par && val === "") {
                                    const puttsNum = parseInt(v, 10);
                                    if (!isNaN(puttsNum) && puttsNum >= 0) {
                                      const autoScore = String(girScoreFromPutts(holeData.par, puttsNum));
                                      setScores((prev) => ({
                                        ...prev,
                                        [rpId]: { ...(prev[rpId] ?? {}), [holeData.hole_number]: autoScore },
                                      }));
                                      autoSavePlayer(rpId);
                                    }
                                  }
                                }}
                                onBlur={() => autoSaveStats(rpId, currentHole, 400)}
                              />
                            </View>
                          </View>
                        );
                      }

                      default:
                        return null;
                    }
                  })}

                  {/* Stats save error — outside the stat loop so it's always visible */}
                  {statsSaveError && (
                    <View className={`px-4 py-2 border-b ${t.divider}`}>
                      <Text className="text-red-500 text-xs">Stats failed to save</Text>
                    </View>
                  )}

                  {/* Score entry — after stats when score_position is "last" (default) */}
                  {settings.score_position !== "first" && renderScoreBlock()}

                  {/* Save status — failure only; successful saves show nothing */}
                  {saveError[rpId] && (
                    <View className={`flex-row items-center justify-center gap-2 py-2 border-t ${t.divider}`}>
                      <Ionicons name="alert-circle" size={14} color="#dc2626" />
                      <Text className="text-xs text-red-600">Save failed — tap score to retry</Text>
                    </View>
                  )}

                </View>
              );
            })()}

            {/* Prev / Next hole navigation */}
            <View className="flex-row items-center justify-between">
              <TouchableOpacity
                onPress={() => setCurrentHole((h) => Math.max(startHole, h - 1))}
                disabled={currentHole === startHole}
                className={`flex-row items-center gap-2 px-6 py-4 rounded-xl ${currentHole === startHole ? "bg-green-700/30" : "bg-green-700"}`}
                activeOpacity={0.7}
              >
                <Ionicons name="chevron-back" size={20} color="white" />
                <Text className="text-base font-semibold text-white">Prev</Text>
              </TouchableOpacity>
              <Text className={`text-sm font-semibold ${t.textTertiary}`}>
                {currentHole} / {lastHole}
              </Text>
              <TouchableOpacity
                onPress={() => setCurrentHole((h) => Math.min(lastHole, h + 1))}
                disabled={currentHole === lastHole}
                className={`flex-row items-center gap-2 px-6 py-4 rounded-xl ${currentHole === lastHole ? "bg-green-700/30" : "bg-green-700"}`}
                activeOpacity={0.7}
              >
                <Text className="text-base font-semibold text-white">Next</Text>
                <Ionicons name="chevron-forward" size={20} color="white" />
              </TouchableOpacity>
            </View>

            {/* Running totals summary */}
            <View className={`flex-row rounded-xl border ${t.border} ${t.surface} overflow-hidden mb-2`}>
              <View className="flex-1 items-center py-3">
                <Text className={`text-xs ${t.textTertiary}`}>Gross</Text>
                <Text className={`text-lg font-bold ${t.textPrimary}`}>
                  {indivGrossCount > 0 ? indivGrossTotal : "—"}
                </Text>
              </View>
              {showNetCol && (
                <View className={`flex-1 items-center py-3 border-l ${t.border}`}>
                  <Text className={`text-xs ${t.textTertiary}`}>Net</Text>
                  <Text className={`text-lg font-bold ${t.textPrimary}`}>
                    {indivNetCount > 0 ? indivNetTotal : "—"}
                  </Text>
                </View>
              )}
              <View className={`flex-1 items-center py-3 border-l ${t.border}`}>
                <Text className={`text-xs ${t.textTertiary}`}>Holes</Text>
                <Text className={`text-lg font-bold ${t.textPrimary}`}>
                  {indivGrossCount}/{holeCount}
                </Text>
              </View>
            </View>

            {/* C.H. edit affordance — at the bottom when 4+ players (inline would crowd the pills row) */}
            {canEditSelectedHandicap && group.players.length >= 4 && (
              editingHandicapFor === selectedPlayerId ? (
                <View className={`flex-row items-center gap-2 px-3 py-2 rounded-xl border ${t.border} ${t.surface}`}>
                  <Ionicons name="golf-outline" size={13} color={t.colors.tabBarInactive} />
                  <Text className={`flex-1 text-xs ${t.textSecondary}`}>
                    {scorecard.is_organizer && selectedPlayerId !== myPlayer?.round_player_id
                      ? `${selectedPlayer?.display_name.split(" ")[0]} C.H.`
                      : "C.H."}
                  </Text>
                  <TextInput
                    className={`w-14 border rounded-lg px-2 py-1 text-center text-sm ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                    placeholder="0"
                    placeholderTextColor={t.colors.tabBarInactive}
                    keyboardType="number-pad"
                    maxLength={2}
                    value={handicapDraft}
                    onChangeText={setHandicapDraft}
                    editable={!savingHandicap}
                    autoFocus
                  />
                  <TouchableOpacity onPress={() => setEditingHandicapFor(null)} hitSlop={8} className="px-1">
                    <Text className={`text-xs ${t.textTertiary}`}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    className={`px-3 py-1 rounded-lg ${savingHandicap ? "bg-green-700/40" : "bg-green-700"}`}
                    onPress={handleSaveHandicap}
                    disabled={savingHandicap}
                  >
                    {savingHandicap
                      ? <ActivityIndicator size="small" color="white" />
                      : <Text className="text-white text-xs font-semibold">Save</Text>
                    }
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  className={`flex-row items-center gap-2 px-3 py-2 rounded-xl border ${t.border} ${t.surface}`}
                  onPress={() => {
                    setHandicapDraft(String(selectedPlayer?.course_handicap ?? ""));
                    setEditingHandicapFor(selectedPlayerId);
                  }}
                  activeOpacity={0.7}
                >
                  <Ionicons name="golf-outline" size={13} color={t.colors.tabBarInactive} />
                  <Text className={`flex-1 text-xs ${t.textSecondary}`}>
                    {scorecard.is_organizer && selectedPlayerId !== myPlayer?.round_player_id
                      ? `${selectedPlayer?.display_name.split(" ")[0]} C.H.`
                      : "C.H."}
                  </Text>
                  <Text className={`text-sm font-bold ${t.textPrimary}`}>{selectedPlayer?.course_handicap}</Text>
                  <Ionicons name="pencil-outline" size={13} color={t.colors.tabBarInactive} />
                </TouchableOpacity>
              )
            )}

          </View>
        )}


      </KeyboardAwareScrollView>
    </View>
  );
}
