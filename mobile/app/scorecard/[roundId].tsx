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
//   4. Non-scramble formats: toggle between group view (all players in columns)
//      and individual view (one player at a time, hole-by-hole).
//      Both views share the same `scores` state — switching never discards data.
//   5. Allows any player in the group (or organizer/admin) to enter scores
//   6. Scores are auto-saved on blur via PUT /rounds/:id/players/:rpId/scores
//   7. Individual view: hole-by-hole card with score entry + GIR/FIR/putts per hole,
//      navigated via hole selector pills or Prev/Next buttons.

import { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  RefreshControl,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth, useUser } from "@clerk/clerk-expo";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import type { Scorecard, ScorecardGroup, ScorecardPlayer } from "@/types/scorecard";
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
  putts: string;
  first_putt_distance: string; // feet
  putt_distance_made: string;  // feet
};

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
// Mirrors the Go HandicapStrokes function in handlers/scores.go.
// A 20-handicap player gets 2 strokes on SI 1–2 and 1 stroke on SI 3–18.
function handicapStrokes(courseHandicap: number, strokeIndex: number): number {
  const base = Math.floor(courseHandicap / 18);
  const remainder = courseHandicap % 18;
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
        putts:               s.putts != null ? String(s.putts) : "",
        first_putt_distance: s.first_putt_distance != null ? String(s.first_putt_distance) : "",
        putt_distance_made:  s.putt_distance_made != null ? String(s.putt_distance_made) : "",
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
  putts: "", first_putt_distance: "", putt_distance_made: "",
};

// scoreColor returns a NativeWind class string for a score relative to par.
// Used in both group and individual views to keep color logic in one place.
function scoreColor(diff: number, textPrimary: string): string {
  if (diff <= -2) return "text-yellow-500"; // Eagle or better
  if (diff === -1) return "text-green-600"; // Birdie
  if (diff === 0)  return textPrimary;      // Par
  if (diff === 1)  return "text-blue-500";  // Bogey
  return "text-red-500";                    // Double+
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

  // ── View mode ───────────────────────────────────────────────────────────────
  // "group": all players shown in columns (always available).
  // "individual": one player at a time, hole-by-hole with score + stats per hole.
  // Only offered for non-scramble formats with 2+ players.
  // Switching never resets scores — both views share the same `scores` state.
  const [viewMode,         setViewMode]         = useState<"group" | "individual">("individual");
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>("");

  // ── Score / handicap / UI state ─────────────────────────────────────────────
  const [scores,          setScores]          = useState<LocalScores>({});
  const [handicaps,       setHandicaps]       = useState<LocalHandicaps>({});
  const [savingHandicaps,   setSavingHandicaps]   = useState(false);
  // handicapDismissed: user tapped "Skip" in the handicap entry section.
  // Hides the section for the rest of the session even if handicaps are missing.
  const [handicapDismissed, setHandicapDismissed] = useState(false);
  const [saveStatus,      setSaveStatus]      = useState<Record<string, "idle" | "saving" | "saved" | "error">>({});

  // ── Advanced stats + hole navigation state ───────────────────────────────────
  const [stats,       setStats]       = useState<LocalStats>({});
  // currentHole drives which hole is displayed in individual view (1-based).
  const [currentHole, setCurrentHole] = useState(1);

  // ── Fetch scorecard ─────────────────────────────────────────────────────────

  const fetchScorecard = useCallback(async (): Promise<Scorecard> => {
    const token = await getToken();
    const res = await fetch(`${API_URL}/api/v1/rounds/${roundId}/scorecard`, {
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
    queryKey: ["scorecard", roundId],
    queryFn:  fetchScorecard,
    enabled:  !!roundId,
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

  // inputRefs: group view grid — key "<holeIndex>-<playerIndex>".
  const inputRefs     = useRef<Map<string, TextInput | null>>(new Map());

  // outerScrollRef: used to programmatically scroll the main ScrollView when
  // the bottom stat inputs (Putts, First Putt, Made Putt) are focused so they
  // are not hidden behind the keyboard.
  const outerScrollRef = useRef<ScrollView>(null);

  // pillScrollRef: horizontal ScrollView holding the hole selector pills.
  // Scrolled automatically when currentHole changes so the active pill is
  // always centred in view without the user having to swipe manually.
  const pillScrollRef = useRef<ScrollView>(null);

  // Scroll the hole pills so the active pill is always centred in view.
  // Each pill is w-9 (36px) with gap-2 (8px) between them = 44px per slot.
  // We subtract half the screen width and add half a pill so it lands centred.
  useEffect(() => {
    const PILL_STEP = 36 + 8; // w-9 + gap-2
    const screenW   = Dimensions.get("window").width;
    const x         = (currentHole - 1) * PILL_STEP - (screenW / 2) + 18;
    pillScrollRef.current?.scrollTo({ x: Math.max(0, x), animated: true });
  }, [currentHole]);

  // userIdRef lets the init effect read user.id without listing it as a dep,
  // avoiding re-runs when Clerk refreshes user data mid-session.
  const userIdRef  = useRef(user?.id);
  useEffect(() => { userIdRef.current = user?.id; }, [user?.id]);

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

        setSaveStatus((prev) => ({ ...prev, [roundPlayerId]: "saving" }));
        try {
          const token = await getToken();
          const res = await fetch(
            `${API_URL}/api/v1/rounds/${roundId}/players/${roundPlayerId}/scores`,
            {
              method:  "PUT",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body:    JSON.stringify({ scores: entries }),
            }
          );
          if (!res.ok) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const body = await res.json().catch(() => ({}));
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            throw new Error(body?.error ?? "Save failed");
          }
          setSaveStatus((prev) => ({ ...prev, [roundPlayerId]: "saved" }));
          setTimeout(
            () => setSaveStatus((prev) => ({ ...prev, [roundPlayerId]: "idle" })),
            2000
          );
        } catch {
          setSaveStatus((prev) => ({ ...prev, [roundPlayerId]: "error" }));
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
          putts:                toInt(entry.putts),
          first_putt_distance:  toInt(entry.first_putt_distance),
          putt_distance_made:   toInt(entry.putt_distance_made),
        };

        try {
          const token = await getToken();
          await fetch(
            `${API_URL}/api/v1/rounds/${roundId}/players/${roundPlayerId}/hole-stats`,
            {
              method:  "PUT",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body:    JSON.stringify({ stats: [stat] }),
            }
          );
        } catch {
          // Silent failure — stats are best-effort and don't block score entry.
        }
      }, delay);

      statSaveTimers.current.set(key, timer);
    },
    [roundId, getToken]
  );

  // ── Focus helpers ────────────────────────────────────────────────────────────

  // Group view: advance to next player in the same hole, then wrap to next hole.
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
      setCurrentHole(1);
      // Default individual view to the current user's player, then first player.
      // user.id matches ScorecardPlayer.user_id (both Clerk user IDs).
      const myPlayer = group.players.find((p) => p.user_id === userIdRef.current);
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
      await Promise.all(
        group.players.map((player) => {
          const hStr = handicaps[player.round_player_id] ?? "";
          const hNum = parseInt(hStr, 10);
          if (isNaN(hNum)) return Promise.resolve();
          return fetch(
            `${API_URL}/api/v1/rounds/${roundId}/players/${player.round_player_id}/handicap`,
            {
              method:  "PUT",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body:    JSON.stringify({ course_handicap: hNum }),
            }
          );
        })
      );
      queryClient.invalidateQueries({ queryKey: ["scorecard", roundId] });
    } catch {
      Alert.alert("Error", "Could not save handicaps. Check your connection and try again.");
    } finally {
      setSavingHandicaps(false);
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

  // Scramble: all players play from the same ball — individual scorecards don't apply.
  const isScramble = scorecard.scoring_format === "scramble";
  // Single-player groups are always shown in individual view so the net column is available.
  const effectiveViewMode = group.players.length === 1 ? "individual" : viewMode;
  const showToggle = !isScramble && group.players.length > 1;

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

  // Show Net column when the selected player has a handicap set.
  const showNetCol = selectedPlayer?.course_handicap != null;

  // Column widths for group view.
  const leftColW       = 38;
  const parColW        = 32;
  const siColW         = 32;
  const playerColW     = 64;

  const totalGroupWidth = leftColW + parColW + siColW + group.players.length * playerColW;

  // Build hole rows. Without tee data, show 1..hole_count with blank par/SI.
  const holeCount = scorecard.hole_count || 18;
  type HoleRowData = { hole_number: number; par: number; stroke_index: number; yardage: number | null };
  const holeMap = new Map<number, HoleRowData>();
  for (const h of scorecard.holes) holeMap.set(h.hole_number, h);
  const holeRows: HoleRowData[] = Array.from({ length: holeCount }, (_, i) => {
    const n = i + 1;
    return holeMap.get(n) ?? { hole_number: n, par: 0, stroke_index: 0, yardage: null };
  });

  // Pre-compute individual view running totals.
  let indivGrossTotal = 0, indivGrossCount = 0;
  let indivNetTotal   = 0, indivNetCount   = 0;
  if (selectedPlayer) {
    const indivInputs = scores[selectedPlayer.round_player_id] ?? {};
    for (const hole of holeRows) {
      const g = parseInt(indivInputs[hole.hole_number] ?? "", 10);
      if (!isNaN(g) && g >= 1) {
        indivGrossTotal += g;
        indivGrossCount++;
        if (showNetCol && selectedPlayer.course_handicap != null && hole.stroke_index) {
          indivNetTotal += g - handicapStrokes(selectedPlayer.course_handicap, hole.stroke_index);
          indivNetCount++;
        }
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      className={`flex-1 ${t.screen}`}
      behavior={Platform.OS === "android" ? "height" : undefined}
    >

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

        {/* Individual / Group toggle — non-scramble, 2+ players only */}
        {showToggle && (
          <View className={`flex-row rounded-lg overflow-hidden border ${t.border}`}>
            <TouchableOpacity
              onPress={() => setViewMode("individual")}
              className={`px-3 py-1.5 ${viewMode === "individual" ? "bg-green-700" : t.surface}`}
            >
              <Text className={`text-xs font-semibold ${viewMode === "individual" ? "text-white" : t.textSecondary}`}>
                Individual
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setViewMode("group")}
              className={`px-3 py-1.5 ${viewMode === "group" ? "bg-green-700" : t.surface}`}
            >
              <Text className={`text-xs font-semibold ${viewMode === "group" ? "text-white" : t.textSecondary}`}>
                Group
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <ScrollView
        ref={outerScrollRef}
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 320 }}
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={t.colors.tabBarActive}
          />
        }
        keyboardShouldPersistTaps="handled"
      >

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
                {needsHandicap ? "Handicap required before entering scores" : "Set Handicaps (optional)"}
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
                    placeholder="HCP"
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
                  <Text className="text-white font-semibold text-sm">Set Handicaps</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Individual view: player selector pills ─────────────────────────── */}
        {effectiveViewMode === "individual" && (
          <View className="flex-row gap-2 px-4 mt-4 flex-wrap">
            {group.players.map((p) => (
              <TouchableOpacity
                key={p.round_player_id}
                onPress={() => setSelectedPlayerId(p.round_player_id)}
                className={`px-3 py-1.5 rounded-full border ${
                  selectedPlayerId === p.round_player_id
                    ? "bg-green-700 border-green-700"
                    : `${t.surface} ${t.border}`
                }`}
              >
                <Text
                  className={`text-sm font-semibold ${
                    selectedPlayerId === p.round_player_id ? "text-white" : t.textPrimary
                  }`}
                  numberOfLines={1}
                >
                  {/* Playing handicap shown in parens; (-) when not yet entered */}
                  {p.display_name.split(" ")[0]} {p.course_handicap != null ? `(${p.course_handicap})` : "(-)"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* ── Scorecard tables ───────────────────────────────────────────────── */}

        {effectiveViewMode === "group" ? (

          /* ── Group view: horizontal scroll, all players in columns ── */
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mt-4">
            <View style={{ width: totalGroupWidth }}>

              {/* Header row */}
              <View className={`flex-row items-center px-2 py-2 ${t.surfaceSunken} border-b ${t.divider}`}>
                <Text style={{ width: leftColW }} className={`text-xs font-bold text-center ${t.textTertiary}`}>H</Text>
                <Text style={{ width: parColW }}  className={`text-xs font-bold text-center ${t.textTertiary}`}>Par</Text>
                <Text style={{ width: siColW }}   className={`text-xs font-bold text-center ${t.textTertiary}`}>SI</Text>
                {group.players.map((p) => {
                  const status = saveStatus[p.round_player_id] ?? "idle";
                  return (
                    <View key={p.round_player_id} style={{ width: playerColW }} className="items-center">
                      <Text className={`text-xs font-bold text-center ${t.textPrimary}`} numberOfLines={1}>
                        {p.display_name.split(" ")[0]}
                      </Text>
                      {/* Playing handicap for this round; (-) when not yet entered */}
                      <Text className={`text-xs text-center ${t.textTertiary}`} numberOfLines={1}>
                        {p.course_handicap != null ? `(${p.course_handicap})` : "(-)"}
                      </Text>
                      {status === "saving" && (
                        // eslint-disable-next-line react-native/no-inline-styles
                        <ActivityIndicator size="small" color={t.colors.tabBarActive} style={{ transform: [{ scale: 0.55 }] }} />
                      )}
                      {status === "saved"  && <Ionicons name="checkmark-circle" size={10} color="#16a34a" />}
                      {status === "error"  && <Ionicons name="alert-circle"     size={10} color="#dc2626" />}
                      {status === "idle"   && <View style={{ height: 10 }} />}
                    </View>
                  );
                })}
              </View>

              {/* Score rows */}
              {holeRows.map((hole, idx) => {
                const isOdd = idx % 2 === 0;
                return (
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
                    {group.players.map((player, playerIdx) => {
                      const val   = scores[player.round_player_id]?.[hole.hole_number] ?? "";
                      const gross = parseInt(val, 10);
                      const color = (hole.par && !isNaN(gross))
                        ? scoreColor(gross - hole.par, t.textPrimary)
                        : t.textPrimary;
                      const isLastCell =
                        idx === holeRows.length - 1 &&
                        playerIdx === group.players.length - 1;
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
                              focusNext(idx, playerIdx, group.players.length, holeRows.length)
                            }
                            onBlur={() => autoSavePlayer(player.round_player_id)}
                            editable={!savingHandicaps && !needsHandicap}
                            placeholder="–"
                            placeholderTextColor={t.colors.tabBarInactive}
                          />
                        </View>
                      );
                    })}
                  </View>
                );
              })}

              {/* Totals row */}
              <View className={`flex-row items-center px-2 py-2 ${t.surfaceSunken} border-t-2 ${t.border}`}>
                <Text style={{ width: leftColW }} className={`text-xs font-bold text-center ${t.textTertiary}`}>TOT</Text>
                <Text style={{ width: parColW }} className={`text-xs font-semibold text-center ${t.textSecondary}`}>
                  {scorecard.holes.reduce((sum, h) => sum + h.par, 0) || "—"}
                </Text>
                <View style={{ width: siColW }} />
                {group.players.map((player) => {
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

          /* ── Individual view: hole-by-hole entry ── */
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
              const hcp        = selectedPlayer.course_handicap ?? null;
              const strokes    = (holeData.stroke_index && hcp != null)
                ? handicapStrokes(hcp, holeData.stroke_index)
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
              // When GIR becomes "hit" and the score is par, auto-set putts to 2
              // (only when putts is blank — don't overwrite a value the user entered).
              const handleGIRTap = (key: string) => {
                const isActive = currentGir === key;
                let gir: string | null = null;
                let dir: string | null = null;
                if (!isActive) {
                  if (key === "hit")                { gir = "hit"; }
                  else if (key === "na")            { gir = "na"; }
                  else if (key.startsWith("miss:")) { gir = "miss"; dir = key.slice(5); }
                }
                const isParScore = !isNaN(gross) && holeData.par != null && gross === holeData.par;
                const autoPutts = gir === "hit" && isParScore && holeStat.putts === "" ? { putts: "2" } : {};
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

                  {/* Score entry row */}
                  <View className={`flex-row items-center justify-center gap-8 px-4 py-5 border-b ${t.divider}`}>
                    <View className="items-center gap-1">
                      <Text className={`text-xs font-semibold uppercase tracking-wide ${t.textTertiary}`}>Score</Text>
                      <TextInput
                        className={`w-20 h-14 border-2 rounded-xl text-center text-3xl font-bold ${t.borderInput} ${t.surfaceSunken} ${grossClr}`}
                        keyboardType="number-pad"
                        maxLength={2}
                        value={val}
                        onChangeText={(v) => {
                          setScores((prev) => ({
                            ...prev,
                            [rpId]: { ...(prev[rpId] ?? {}), [holeData.hole_number]: v },
                          }));
                          // Auto-set putts to 2 when the score becomes par and GIR is
                          // already "hit", but only if putts hasn't been entered yet.
                          const newGross = parseInt(v, 10);
                          if (
                            !isNaN(newGross) &&
                            holeData.par != null &&
                            newGross === holeData.par &&
                            currentGir === "hit" &&
                            holeStat.putts === ""
                          ) {
                            setStats((prev) => ({
                              ...prev,
                              [rpId]: {
                                ...(prev[rpId] ?? {}),
                                [currentHole]: { ...(prev[rpId]?.[currentHole] ?? emptyHoleStat), putts: "2" },
                              },
                            }));
                          }
                        }}
                        onBlur={() => autoSavePlayer(rpId)}
                        editable={!savingHandicaps && !needsHandicap}
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
                        <Text className={`text-xs font-semibold uppercase tracking-wide ${t.textTertiary}`}>HCP</Text>
                        <View className={`w-16 h-14 border-2 rounded-xl items-center justify-center ${t.border} ${t.surfaceSunken}`}>
                          <Text className={`text-2xl font-bold ${t.textTertiary}`}>+{strokes}</Text>
                        </View>
                      </View>
                    )}
                  </View>

                  {/* Save status — inline, shown only while active */}
                  {saveStatus[rpId] !== undefined && saveStatus[rpId] !== "idle" && (
                    <View className={`flex-row items-center justify-center gap-2 py-2 border-b ${t.divider}`}>
                      {saveStatus[rpId] === "saving" && (
                        <>
                          <ActivityIndicator size="small" color={t.colors.tabBarActive} />
                          <Text className={`text-xs ${t.textTertiary}`}>Saving…</Text>
                        </>
                      )}
                      {saveStatus[rpId] === "saved" && (
                        <>
                          <Ionicons name="checkmark-circle" size={14} color="#16a34a" />
                          <Text className="text-xs text-green-700">Saved</Text>
                        </>
                      )}
                      {saveStatus[rpId] === "error" && (
                        <>
                          <Ionicons name="alert-circle" size={14} color="#dc2626" />
                          <Text className="text-xs text-red-600">Save failed — tap score to retry</Text>
                        </>
                      )}
                    </View>
                  )}

                  {/* GIR */}
                  <View className={`px-4 py-3 gap-2 border-b ${t.divider}`}>
                    <Text className={`text-xs font-semibold uppercase tracking-wide ${t.textTertiary}`}>
                      Green in Regulation
                    </Text>
                    <View className="flex-row flex-wrap gap-2">
                      {GIR_OPTIONS.map(({ key, label, icon }) => {
                        const active = currentGir === key;
                        return (
                          <TouchableOpacity
                            key={key}
                            onPress={() => handleGIRTap(key)}
                            className={`flex-row items-center gap-1 px-3 py-1.5 rounded-full border ${
                              active ? "bg-green-700 border-green-700" : `${t.surface} ${t.border}`
                            }`}
                            activeOpacity={0.7}
                          >
                            {icon && (
                              <Ionicons
                                name={icon}
                                size={12}
                                color={active ? "white" : t.colors.tabBarActive}
                              />
                            )}
                            <Text className={`text-xs font-semibold ${active ? "text-white" : t.textSecondary}`}>
                              {label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>

                  {/* FIR */}
                  <View className={`px-4 py-3 gap-2 border-b ${t.divider}`}>
                    <Text className={`text-xs font-semibold uppercase tracking-wide ${t.textTertiary}`}>
                      Fairway in Regulation
                    </Text>
                    <View className="flex-row flex-wrap gap-2">
                      {FIR_OPTIONS.map(({ key, label, icon }) => {
                        const active = currentFir === key;
                        return (
                          <TouchableOpacity
                            key={key}
                            onPress={() => handleFIRTap(key)}
                            className={`flex-row items-center gap-1 px-3 py-1.5 rounded-full border ${
                              active ? "bg-green-700 border-green-700" : `${t.surface} ${t.border}`
                            }`}
                            activeOpacity={0.7}
                          >
                            {icon && (
                              <Ionicons
                                name={icon}
                                size={12}
                                color={active ? "white" : t.colors.tabBarActive}
                              />
                            )}
                            <Text className={`text-xs font-semibold ${active ? "text-white" : t.textSecondary}`}>
                              {label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>

                  {/* Numeric stats */}
                  <View className="px-4 py-3 gap-3">
                    {(
                      [
                        { field: "putts" as const,               label: "Putts",      unit: null },
                        { field: "putt_distance_made" as const,  label: "Made Putt",  unit: "ft" },
                        { field: "first_putt_distance" as const, label: "First Putt", unit: "ft" },
                      ] as const
                    ).map(({ field, label, unit }) => (
                      <View key={field} className="flex-row items-center justify-between">
                        <Text className={`text-sm ${t.textSecondary}`}>
                          {label}{unit ? ` (${unit})` : ""}
                        </Text>
                        <TextInput
                          className={`w-20 border rounded-lg px-2 py-1.5 text-center text-sm ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                          keyboardType="number-pad"
                          maxLength={3}
                          placeholder="—"
                          placeholderTextColor={t.colors.tabBarInactive}
                          value={holeStat[field]}
                          onChangeText={(v) => {
                            setStats((prev) => {
                              const current = prev[rpId]?.[currentHole] ?? emptyHoleStat;
                              // When putts = 1 and the user types into Made Putt, mirror
                              // the value into First Putt — if you only putted once, the
                              // first putt distance is the same as the made putt distance.
                              const extra =
                                field === "putt_distance_made" && current.putts === "1"
                                  ? { first_putt_distance: v }
                                  : {};
                              return {
                                ...prev,
                                [rpId]: {
                                  ...(prev[rpId] ?? {}),
                                  [currentHole]: { ...current, [field]: v, ...extra },
                                },
                              };
                            });
                          }}
                          onFocus={() => {
                            // Delay lets the keyboard animation start before we scroll,
                            // ensuring the inset has been applied and there is room to move.
                            setTimeout(() => outerScrollRef.current?.scrollToEnd({ animated: true }), 150);
                          }}
                          onBlur={() => {
                            autoSaveStats(rpId, currentHole, 400);
                            // Return the view to the top so the blank keyboard inset space
                            // doesn't linger after the keyboard dismisses.
                            setTimeout(() => outerScrollRef.current?.scrollTo({ x: 0, y: 0, animated: true }), 150);
                          }}
                        />
                      </View>
                    ))}
                  </View>

                </View>
              );
            })()}

            {/* Prev / Next hole navigation */}
            <View className="flex-row items-center justify-between">
              <TouchableOpacity
                onPress={() => setCurrentHole((h) => Math.max(1, h - 1))}
                disabled={currentHole === 1}
                className={`flex-row items-center gap-2 px-6 py-4 rounded-xl ${currentHole === 1 ? "bg-green-700/30" : "bg-green-700"}`}
                activeOpacity={0.7}
              >
                <Ionicons name="chevron-back" size={20} color="white" />
                <Text className="text-base font-semibold text-white">Prev</Text>
              </TouchableOpacity>
              <Text className={`text-sm font-semibold ${t.textTertiary}`}>
                {currentHole} / {holeCount}
              </Text>
              <TouchableOpacity
                onPress={() => setCurrentHole((h) => Math.min(holeCount, h + 1))}
                disabled={currentHole === holeCount}
                className={`flex-row items-center gap-2 px-6 py-4 rounded-xl ${currentHole === holeCount ? "bg-green-700/30" : "bg-green-700"}`}
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

          </View>
        )}


      </ScrollView>
    </KeyboardAvoidingView>
  );
}
