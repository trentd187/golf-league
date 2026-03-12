// app/scorecard/[roundId].tsx
// Scorecard screen for a single tee-time group within a round.
//
// Route: /scorecard/:roundId?groupId=<groupId>
// Navigate to this screen from the round detail screen by tapping "Scorecard"
// on a group card.
//
// What it does:
//   1. Fetches GET /api/v1/rounds/:roundId/scorecard
//   2. Filters to the group matching the `groupId` search param
//   3. If the round requires handicaps and any player is missing one, shows a
//      handicap entry section at the top before score entry is available
//   4. Shows an 18-hole (or 9-hole) grid: rows = holes, columns = players
//   5. Allows any player in the group (or organizer/admin) to enter scores
//   6. "Save Scores" submits all changes via PUT /rounds/:id/players/:rpId/scores
//      for each player in parallel

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
import { useAuth } from "@clerk/clerk-expo";
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScorecardScreen() {
  const { roundId } = useLocalSearchParams<{ roundId: string }>();
  // groupId and groupNumber come in as search (query) params.
  const { groupId, groupNumber } = useLocalSearchParams<{
    groupId: string;
    groupNumber: string;
  }>();
  const router = useRouter();
  const { getToken } = useAuth();
  const t = useTheme();
  const queryClient = useQueryClient();

  // Local editable state — populated when data loads; reset on refresh.
  const [scores,          setScores]          = useState<LocalScores>({});
  const [handicaps,       setHandicaps]       = useState<LocalHandicaps>({});
  // savingHandicaps blocks the handicap form while the PUT request is in-flight.
  const [savingHandicaps, setSavingHandicaps] = useState(false);
  // saveStatus tracks the auto-save state per player for the column header indicator.
  const [saveStatus, setSaveStatus] = useState<Record<string, "idle" | "saving" | "saved" | "error">>({});
  const [endingRound, setEndingRound] = useState(false);

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
    queryFn: fetchScorecard,
    enabled: !!roundId,
  });

  // Find the target group — may be undefined while loading.
  const group: ScorecardGroup | undefined = scorecard?.groups.find(
    (g) => g.group_id === groupId
  );

  // scoresRef mirrors scores state so autoSavePlayer reads the latest value without
  // being recreated on every keystroke (which would cause onBlur prop churn).
  const scoresRef = useRef(scores);
  useEffect(() => { scoresRef.current = scores; }, [scores]);

  // saveTimers debounces per-player saves: rapid tabbing through cells collapses
  // into a single request fired 400ms after the last blur on that player's cells.
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // autoSavePlayer collects all entered scores for one player and PUTs them to the API.
  // Debounced so that tabbing through multiple cells only fires one request.
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
              method: "PUT",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ scores: entries }),
            }
          );
          if (!res.ok) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const body = await res.json().catch(() => ({}));
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            throw new Error(body?.error ?? "Save failed");
          }
          setSaveStatus((prev) => ({ ...prev, [roundPlayerId]: "saved" }));
          // Clear the checkmark after 2 s so it doesn't distract during further entry.
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

  // inputRefs stores a TextInput ref for each score cell.
  // Key: "<holeIndex>-<playerIndex>" matching the render order of holeRows × group.players.
  const inputRefs = useRef<Map<string, TextInput | null>>(new Map());

  // focusNext advances the keyboard cursor to the next player in the same hole, or
  // wraps to the first player of the next hole at the end of a row.
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

  // Initialise local score/handicap state once when the group first loads.
  // A ref guard prevents re-initialisation on background refetches, which would
  // clobber in-progress edits. A new mount (navigate away + back) resets the ref.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (group && !initializedRef.current) {
      setScores(initScores(group.players));
      setHandicaps(initHandicaps(group.players));
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

  // handleEndRound marks the round completed and navigates back to the round detail.
  // The button is only shown to organizers (is_organizer from the scorecard response);
  // the backend also enforces this via isRoundOrganizer.
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
                method: "PATCH",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ status: "completed" }),
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

  const needsHandicap = scorecard.requires_handicap &&
    group.players.some((p) => p.course_handicap == null);

  // Column widths: fixed left columns + player columns.
  // Player column width is fixed at 64px — fits 4 players on a 375px screen.
  const leftColW = 38;  // Hole #
  const parColW  = 32;  // Par
  const siColW   = 32;  // SI
  const playerColW = 64;
  const totalWidth = leftColW + parColW + siColW + group.players.length * playerColW;

  // Build hole rows. If there's no tee data, show 1..hole_count with blank par/SI.
  const holeCount = scorecard.hole_count || 18;
  type HoleRowData = { hole_number: number; par: number; stroke_index: number; yardage: number | null };
  const holeMap = new Map<number, HoleRowData>();
  for (const h of scorecard.holes) {
    holeMap.set(h.hole_number, h);
  }
  const holeRows: HoleRowData[] = Array.from({ length: holeCount }, (_, i) => {
    const n = i + 1;
    return holeMap.get(n) ?? { hole_number: n, par: 0, stroke_index: 0, yardage: null };
  });

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      className={`flex-1 ${t.screen}`}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {/* Header */}
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
        {needsHandicap && (
          <View className={`mx-4 mt-4 rounded-2xl border ${t.border} ${t.surface} overflow-hidden`}>
            <View className={`px-4 py-3 border-b ${t.divider} flex-row items-center gap-2`}>
              <Ionicons name="information-circle-outline" size={16} color="#d97706" />
              <Text className={`text-sm font-semibold text-amber-700`}>
                Handicap required before entering scores
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

        {/* ── Scorecard table ────────────────────────────────────────────────── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mt-4">
          <View style={{ width: totalWidth }}>

            {/* Header row: Hole | Par | SI | [player names...] */}
            <View
              className={`flex-row items-center px-2 py-2 ${t.surfaceSunken} border-b ${t.divider}`}
            >
              <Text
                style={{ width: leftColW }}
                className={`text-xs font-bold text-center ${t.textTertiary}`}
              >
                H
              </Text>
              <Text
                style={{ width: parColW }}
                className={`text-xs font-bold text-center ${t.textTertiary}`}
              >
                Par
              </Text>
              <Text
                style={{ width: siColW }}
                className={`text-xs font-bold text-center ${t.textTertiary}`}
              >
                SI
              </Text>
              {group.players.map((p) => {
                const status = saveStatus[p.round_player_id] ?? "idle";
                return (
                  <View key={p.round_player_id} style={{ width: playerColW }} className="items-center">
                    <Text
                      className={`text-xs font-bold text-center ${t.textPrimary}`}
                      numberOfLines={1}
                    >
                      {p.display_name.split(" ")[0]}
                    </Text>
                    {status === "saving" && (
                      <ActivityIndicator size="small" color={t.colors.tabBarActive} style={{ transform: [{ scale: 0.55 }] }} />
                    )}
                    {status === "saved" && (
                      <Ionicons name="checkmark-circle" size={10} color="#16a34a" />
                    )}
                    {status === "error" && (
                      <Ionicons name="alert-circle" size={10} color="#dc2626" />
                    )}
                    {status === "idle" && <View style={{ height: 10 }} />}
                  </View>
                );
              })}
            </View>

            {/* Score rows — one per hole */}
            {holeRows.map((hole, idx) => {
              // Alternating row background for readability.
              const isOdd = idx % 2 === 0;
              return (
                <View
                  key={hole.hole_number}
                  className={`flex-row items-center px-2 py-1 border-b ${t.divider} ${isOdd ? t.surface : t.surfaceSunken}`}
                >
                  <Text
                    style={{ width: leftColW }}
                    className={`text-sm font-semibold text-center ${t.textPrimary}`}
                  >
                    {hole.hole_number}
                  </Text>
                  <Text
                    style={{ width: parColW }}
                    className={`text-xs text-center ${hole.par ? t.textSecondary : t.textTertiary}`}
                  >
                    {hole.par || "—"}
                  </Text>
                  <Text
                    style={{ width: siColW }}
                    className={`text-xs text-center ${hole.stroke_index ? t.textTertiary : t.textTertiary}`}
                  >
                    {hole.stroke_index || "—"}
                  </Text>
                  {group.players.map((player, playerIdx) => {
                    const val = scores[player.round_player_id]?.[hole.hole_number] ?? "";
                    const gross = parseInt(val, 10);
                    // Color-code relative to par when hole data exists.
                    let scoreColor = t.textPrimary;
                    if (hole.par && !isNaN(gross)) {
                      const diff = gross - hole.par;
                      if (diff <= -2) scoreColor = "text-yellow-500"; // Eagle or better
                      else if (diff === -1) scoreColor = "text-green-600"; // Birdie
                      else if (diff === 0) scoreColor = t.textPrimary;   // Par
                      else if (diff === 1) scoreColor = "text-blue-500";  // Bogey
                      else scoreColor = "text-red-500";                   // Double+
                    }
                    const isLastCell =
                      idx === holeRows.length - 1 &&
                      playerIdx === group.players.length - 1;
                    return (
                      <View key={player.round_player_id} style={{ width: playerColW }} className="items-center px-1">
                        <TextInput
                          ref={(el) => { inputRefs.current.set(`${idx}-${playerIdx}`, el); }}
                          className={`w-full border rounded-lg text-center text-sm py-1 ${t.borderInput} ${t.surfaceSunken} ${scoreColor}`}
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
            <View
              className={`flex-row items-center px-2 py-2 ${t.surfaceSunken} border-t-2 ${t.border}`}
            >
              <Text
                style={{ width: leftColW }}
                className={`text-xs font-bold text-center ${t.textTertiary}`}
              >
                TOT
              </Text>
              {/* Par total */}
              <Text
                style={{ width: parColW }}
                className={`text-xs font-semibold text-center ${t.textSecondary}`}
              >
                {scorecard.holes.reduce((sum, h) => sum + h.par, 0) || "—"}
              </Text>
              {/* SI column — blank in totals row */}
              <View style={{ width: siColW }} />
              {group.players.map((player) => {
                // Calculate a running gross total from local state.
                const playerInputs = scores[player.round_player_id] ?? {};
                let total = 0;
                let count = 0;
                for (const v of Object.values(playerInputs)) {
                  const n = parseInt(v, 10);
                  if (!isNaN(n) && n >= 1) { total += n; count++; }
                }
                return (
                  <Text
                    key={player.round_player_id}
                    style={{ width: playerColW }}
                    className={`text-sm font-bold text-center ${t.textPrimary}`}
                  >
                    {count > 0 ? total : "—"}
                  </Text>
                );
              })}
            </View>

          </View>
        </ScrollView>

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
