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
//      and individual view (one player at a time, with net score column).
//      Both views share the same `scores` state — switching never discards data.
//   5. Allows any player in the group (or organizer/admin) to enter scores
//   6. Scores are auto-saved on blur via PUT /rounds/:id/players/:rpId/scores

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
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth, useUser } from "@clerk/clerk-expo";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import type { Scorecard, ScorecardGroup, ScorecardPlayer } from "@/types/scorecard";

// ─── Types ────────────────────────────────────────────────────────────────────

// LocalScores maps round_player_id → hole_number → gross score string input.
// String rather than number so empty input fields stay blank.
type LocalScores = Record<string, Record<number, string>>;

// LocalHandicaps maps round_player_id → handicap string input.
type LocalHandicaps = Record<string, string>;

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
  // "group": all players shown in columns (default, always available).
  // "individual": one player at a time with gross + net score columns.
  // Only offered for non-scramble formats with 2+ players.
  // Switching never resets scores — both views share the same `scores` state.
  const [viewMode,         setViewMode]         = useState<"group" | "individual">("group");
  const [selectedPlayerId, setSelectedPlayerId] = useState<string>("");

  // ── Score / handicap / UI state ─────────────────────────────────────────────
  const [scores,          setScores]          = useState<LocalScores>({});
  const [handicaps,       setHandicaps]       = useState<LocalHandicaps>({});
  const [savingHandicaps, setSavingHandicaps] = useState(false);
  const [saveStatus,      setSaveStatus]      = useState<Record<string, "idle" | "saving" | "saved" | "error">>({});
  const [endingRound,     setEndingRound]     = useState(false);

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

  // saveTimers debounces per-player saves: rapid tabbing collapses into one request.
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // inputRefs: group view grid — key "<holeIndex>-<playerIndex>".
  const inputRefs  = useRef<Map<string, TextInput | null>>(new Map());

  // indivInputRefs: individual view grid — key is hole_number (1-based).
  const indivInputRefs = useRef<Map<number, TextInput | null>>(new Map());

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

  // Individual view: advance straight to the next hole.
  const focusNextIndiv = useCallback((holeNumber: number, totalHoles: number) => {
    if (holeNumber < totalHoles) {
      indivInputRefs.current.get(holeNumber + 1)?.focus();
    }
  }, []);

  // ── Initialisation ──────────────────────────────────────────────────────────

  const initializedRef = useRef(false);
  useEffect(() => {
    if (group && !initializedRef.current) {
      setScores(initScores(group.players));
      setHandicaps(initHandicaps(group.players));
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

  // ── End round ───────────────────────────────────────────────────────────────

  const handleEndRound = () => {
    Alert.alert(
      "End Round?",
      "This will mark the round as completed for all groups.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "End Round",
          style: "destructive",
          onPress: async () => {
            setEndingRound(true);
            try {
              const token = await getToken();
              const res = await fetch(`${API_URL}/api/v1/rounds/${roundId}`, {
                method:  "PATCH",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body:    JSON.stringify({ status: "completed" }),
              });
              if (!res.ok) {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                const body = await res.json().catch(() => ({}));
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                throw new Error(body?.error ?? "Failed to end round");
              }
              router.back();
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : "Check your connection and try again.";
              Alert.alert("Could not end round", msg);
            } finally {
              setEndingRound(false);
            }
          },
        },
      ]
    );
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

  // Show the handicap section whenever any player is missing one — even when
  // the round doesn't require it (optional entry so net scores become available).
  const showHandicapSection = group.players.some((p) => p.course_handicap == null);

  // Show Net column when the selected player has a handicap set.
  const showNetCol = selectedPlayer?.course_handicap != null;

  // Column widths.
  const leftColW       = 38;   // Hole #
  const parColW        = 32;   // Par
  const siColW         = 32;   // SI
  const playerColW     = 64;   // Per-player column (group view)
  const indivScoreColW = 84;   // Score column (individual view)
  const indivNetColW   = 60;   // Net column (individual view)

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

  // Pre-compute individual view totals (trivially cheap; avoids IIFE in JSX).
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
      behavior={Platform.OS === "ios" ? "padding" : undefined}
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

        {/* Group / Individual toggle — non-scramble, 2+ players only */}
        {showToggle && (
          <View className={`flex-row rounded-lg overflow-hidden border ${t.border}`}>
            <TouchableOpacity
              onPress={() => setViewMode("group")}
              className={`px-3 py-1.5 ${viewMode === "group" ? "bg-green-700" : t.surface}`}
            >
              <Text className={`text-xs font-semibold ${viewMode === "group" ? "text-white" : t.textSecondary}`}>
                Group
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setViewMode("individual")}
              className={`px-3 py-1.5 ${viewMode === "individual" ? "bg-green-700" : t.surface}`}
            >
              <Text className={`text-xs font-semibold ${viewMode === "individual" ? "text-white" : t.textSecondary}`}>
                Individual
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 40 }}
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
              <Text className={`text-sm font-semibold ${needsHandicap ? "text-amber-700" : t.textSecondary}`}>
                {needsHandicap ? "Handicap required before entering scores" : "Set Handicaps (optional)"}
              </Text>
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
        {effectiveViewMode === "individual" && group.players.length > 1 && (
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
                  {p.display_name.split(" ")[0]}
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

          /* ── Individual view: single-player, optional net column ── */
          <View className="mt-4 px-4">

            {/* Header row */}
            <View className={`flex-row items-center py-2 ${t.surfaceSunken} border-b ${t.divider} rounded-t-xl overflow-hidden`}>
              <Text style={{ width: leftColW }}       className={`text-xs font-bold text-center ${t.textTertiary}`}>H</Text>
              <Text style={{ width: parColW }}        className={`text-xs font-bold text-center ${t.textTertiary}`}>Par</Text>
              <Text style={{ width: siColW }}         className={`text-xs font-bold text-center ${t.textTertiary}`}>SI</Text>
              <Text style={{ width: indivScoreColW }} className={`text-xs font-bold text-center ${t.textTertiary}`}>Score</Text>
              {showNetCol && (
                <Text style={{ width: indivNetColW }} className={`text-xs font-bold text-center ${t.textTertiary}`}>Net</Text>
              )}
            </View>

            {/* Score rows */}
            {holeRows.map((hole, idx) => {
              const isOdd    = idx % 2 === 0;
              const val      = scores[selectedPlayer?.round_player_id]?.[hole.hole_number] ?? "";
              const gross    = parseInt(val, 10);
              const grossClr = (hole.par && !isNaN(gross))
                ? scoreColor(gross - hole.par, t.textPrimary)
                : t.textPrimary;

              // Net score = gross − handicap strokes for this hole.
              const hcp      = selectedPlayer?.course_handicap ?? null;
              const strokes  = (hole.stroke_index && hcp != null)
                ? handicapStrokes(hcp, hole.stroke_index)
                : 0;
              const net      = (!isNaN(gross) && gross >= 1) ? gross - strokes : null;
              const netClr   = (net != null && hole.par)
                ? scoreColor(net - hole.par, t.textPrimary)
                : t.textPrimary;

              return (
                <View
                  key={hole.hole_number}
                  className={`flex-row items-center py-1 border-b ${t.divider} ${isOdd ? t.surface : t.surfaceSunken}`}
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
                  <View style={{ width: indivScoreColW }} className="items-center px-2">
                    <TextInput
                      ref={(el) => { indivInputRefs.current.set(hole.hole_number, el); }}
                      className={`w-full border rounded-lg text-center text-sm py-1 ${t.borderInput} ${t.surfaceSunken} ${grossClr}`}
                      keyboardType="number-pad"
                      maxLength={2}
                      returnKeyType={idx === holeRows.length - 1 ? "done" : "next"}
                      value={val}
                      onChangeText={(v) =>
                        setScores((prev) => ({
                          ...prev,
                          [selectedPlayer.round_player_id]: {
                            ...(prev[selectedPlayer.round_player_id] ?? {}),
                            [hole.hole_number]: v,
                          },
                        }))
                      }
                      onSubmitEditing={() => focusNextIndiv(hole.hole_number, holeCount)}
                      onBlur={() => autoSavePlayer(selectedPlayer.round_player_id)}
                      editable={!savingHandicaps && !needsHandicap}
                      placeholder="–"
                      placeholderTextColor={t.colors.tabBarInactive}
                    />
                  </View>
                  {showNetCol && (
                    <Text style={{ width: indivNetColW }} className={`text-sm font-semibold text-center ${netClr}`}>
                      {net != null ? net : "—"}
                    </Text>
                  )}
                </View>
              );
            })}

            {/* Totals row */}
            <View className={`flex-row items-center py-2 ${t.surfaceSunken} border-t-2 ${t.border} rounded-b-xl overflow-hidden`}>
              <Text style={{ width: leftColW }} className={`text-xs font-bold text-center ${t.textTertiary}`}>TOT</Text>
              <Text style={{ width: parColW }} className={`text-xs font-semibold text-center ${t.textSecondary}`}>
                {scorecard.holes.reduce((sum, h) => sum + h.par, 0) || "—"}
              </Text>
              <View style={{ width: siColW }} />
              <Text style={{ width: indivScoreColW }} className={`text-sm font-bold text-center ${t.textPrimary}`}>
                {indivGrossCount > 0 ? indivGrossTotal : "—"}
              </Text>
              {showNetCol && (
                <Text style={{ width: indivNetColW }} className={`text-sm font-bold text-center ${t.textPrimary}`}>
                  {indivNetCount > 0 ? indivNetTotal : "—"}
                </Text>
              )}
            </View>

            {/* Save status indicator — shown below the individual table */}
            {selectedPlayer && saveStatus[selectedPlayer.round_player_id] !== "idle" && (
              <View className="flex-row items-center justify-center gap-2 mt-3">
                {saveStatus[selectedPlayer.round_player_id] === "saving" && (
                  <>
                    <ActivityIndicator size="small" color={t.colors.tabBarActive} />
                    <Text className={`text-xs ${t.textTertiary}`}>Saving…</Text>
                  </>
                )}
                {saveStatus[selectedPlayer.round_player_id] === "saved" && (
                  <>
                    <Ionicons name="checkmark-circle" size={14} color="#16a34a" />
                    <Text className="text-xs text-green-700">Saved</Text>
                  </>
                )}
                {saveStatus[selectedPlayer.round_player_id] === "error" && (
                  <>
                    <Ionicons name="alert-circle" size={14} color="#dc2626" />
                    <Text className="text-xs text-red-600">Save failed — tap a cell to retry</Text>
                  </>
                )}
              </View>
            )}

          </View>
        )}

        {/* ── End Round button — organizer only ──────────────────────────────── */}
        {scorecard.is_organizer && (
          <View className="px-4 mt-5 mb-2">
            <TouchableOpacity
              className={`rounded-xl py-4 items-center flex-row justify-center gap-2 ${
                endingRound ? "bg-green-700/40" : "bg-green-700"
              }`}
              onPress={handleEndRound}
              disabled={endingRound}
              activeOpacity={0.8}
            >
              {endingRound ? (
                <ActivityIndicator color="white" />
              ) : (
                <>
                  <Ionicons name="flag-outline" size={16} color="white" />
                  <Text className="text-white font-semibold text-base">End Round</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

      </ScrollView>
    </KeyboardAvoidingView>
  );
}
