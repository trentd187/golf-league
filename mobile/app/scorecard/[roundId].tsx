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

import { useState, useCallback, useRef } from "react";
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
  const [scores,    setScores]    = useState<LocalScores>({});
  const [handicaps, setHandicaps] = useState<LocalHandicaps>({});
  const [saving,    setSaving]    = useState(false);

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
    // Populate local state each time fresh data arrives from the server.
    // `select` runs after each successful fetch and lets us initialise scores
    // from the server without a separate useEffect.
    select: (data) => {
      const group = data.groups.find((g) => g.group_id === groupId);
      if (group) {
        setScores(initScores(group.players));
        setHandicaps(initHandicaps(group.players));
      }
      return data;
    },
  });

  // Find the target group — may be undefined while loading.
  const group: ScorecardGroup | undefined = scorecard?.groups.find(
    (g) => g.group_id === groupId
  );

  // ── Handicap save ───────────────────────────────────────────────────────────

  const handleSaveHandicaps = async () => {
    if (!group) return;
    setSaving(true);
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
      setSaving(false);
    }
  };

  // ── Score save ──────────────────────────────────────────────────────────────

  const handleSaveScores = async () => {
    if (!group || !scorecard) return;

    // Build the payload for each player: only include holes that have a valid score entered.
    const payloads = group.players.map((player) => {
      const playerScores: { hole_number: number; gross_score: number }[] = [];
      const holeInputs = scores[player.round_player_id] ?? {};
      for (const [holeStr, valStr] of Object.entries(holeInputs)) {
        const gross = parseInt(valStr, 10);
        if (!isNaN(gross) && gross >= 1) {
          playerScores.push({ hole_number: parseInt(holeStr, 10), gross_score: gross });
        }
      }
      return { player, scoreEntries: playerScores };
    });

    // Require at least one score across all players before submitting.
    const anyScore = payloads.some((p) => p.scoreEntries.length > 0);
    if (!anyScore) {
      Alert.alert("No scores", "Enter at least one score before saving.");
      return;
    }

    setSaving(true);
    try {
      const token = await getToken();
      const results = await Promise.all(
        payloads
          .filter((p) => p.scoreEntries.length > 0)
          .map(({ player, scoreEntries }) =>
            fetch(
              `${API_URL}/api/v1/rounds/${roundId}/players/${player.round_player_id}/scores`,
              {
                method:  "PUT",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body:    JSON.stringify({ scores: scoreEntries }),
              }
            ).then(async (res) => {
              if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error ?? "Failed to save scores");
              }
            })
          )
      );
      void results; // suppress unused-variable lint warning
      queryClient.invalidateQueries({ queryKey: ["scorecard", roundId] });
      Alert.alert("Saved", "Scores saved successfully.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Check your connection and try again.";
      Alert.alert("Error saving scores", msg);
    } finally {
      setSaving(false);
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
                    editable={!saving}
                  />
                </View>
              ))}
              <TouchableOpacity
                className={`rounded-xl py-3 items-center mt-1 ${saving ? "bg-green-700/40" : "bg-green-700"}`}
                onPress={handleSaveHandicaps}
                disabled={saving}
              >
                {saving ? (
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
              {group.players.map((p) => (
                <Text
                  key={p.round_player_id}
                  style={{ width: playerColW }}
                  className={`text-xs font-bold text-center ${t.textPrimary}`}
                  numberOfLines={1}
                >
                  {p.display_name.split(" ")[0]}
                </Text>
              ))}
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
                  {group.players.map((player) => {
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
                    return (
                      <View key={player.round_player_id} style={{ width: playerColW }} className="items-center px-1">
                        <TextInput
                          className={`w-full border rounded-lg text-center text-sm py-1 ${t.borderInput} ${t.surfaceSunken} ${scoreColor}`}
                          keyboardType="number-pad"
                          maxLength={2}
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
                          editable={!saving && !needsHandicap}
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

        {/* ── Save button ─────────────────────────────────────────────────────── */}
        <View className="px-4 mt-5">
          <TouchableOpacity
            className={`rounded-xl py-4 items-center ${saving || needsHandicap ? "bg-green-700/40" : "bg-green-700"}`}
            onPress={handleSaveScores}
            disabled={saving || needsHandicap}
          >
            {saving ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-white font-semibold text-base">Save Scores</Text>
            )}
          </TouchableOpacity>
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}
