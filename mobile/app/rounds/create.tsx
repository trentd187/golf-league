// app/rounds/create.tsx
// New-round creation screen — accessible from the "+" button on the My Rounds tab.
// Creates an eventless (casual) round via POST /api/v1/rounds. The calling user
// is auto-added to Group 1 by the backend. On success the screen navigates to
// the new round's detail page (router.replace so back-nav returns to My Rounds,
// not this form).

import { useState } from "react";
import {
  Text,
  View,
  ScrollView,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";

import { useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Ionicons from "@expo/vector-icons/Ionicons";

import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import { showAlert } from "@/utils/alerts";
import DateInput, { displayToApi } from "@/components/DateInput";
import CoursePickerModal, { PickedCourse } from "@/components/CoursePickerModal";
import { chunk } from "@/utils/array";
import { SCORING_FORMATS } from "@/utils/scoringFormats";

export default function CreateRoundScreen() {
  const t = useTheme();
  const router = useRouter();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const [roundName, setRoundName] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [scoringFormat, setScoringFormat] = useState("stroke");
  const [selectedCourse, setSelectedCourse] = useState<PickedCourse | null>(null);
  const [selectedTeeId, setSelectedTeeId] = useState<string | null>(null);
  const [coursePickerVisible, setCoursePickerVisible] = useState(false);

  const createMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();

      // Validate required fields client-side first.
      if (!scheduledDate) {
        throw new Error("Please enter a date.");
      }
      const apiDate = displayToApi(scheduledDate);
      if (!apiDate) {
        throw new Error("Invalid date — use MM-DD-YY format.");
      }
      if (!selectedCourse) {
        throw new Error("Please select a golf course.");
      }
      if (selectedCourse.tees.length > 0 && !selectedTeeId) {
        throw new Error("Please select a tee set for this course.");
      }

      // Build payload — prefer explicit IDs when the course has tees.
      const payload: Record<string, unknown> = {
        scheduled_date: apiDate,
        scoring_format: scoringFormat,
      };
      if (roundName.trim()) {
        payload.name = roundName.trim();
      }
      if (selectedTeeId) {
        payload.course_id = selectedCourse.id;
        payload.default_tee_id = selectedTeeId;
      } else {
        // No tees configured — backend will find-or-create a default tee.
        payload.course_name = selectedCourse.name;
      }

      const res = await apiFetch(`${API_URL}/api/v1/rounds`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to create round");
      }
      return res.json() as Promise<{ id: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["my-rounds"] });
      // Replace so tapping back from the round detail returns to My Rounds, not this form.
      router.replace(`/rounds/${data.id}`);
    },
    onError: (err: Error) => {
      showAlert("Could not create round", err.message);
    },
  });

  const isPending = createMutation.isPending;

  return (
    <KeyboardAvoidingView
      className={`flex-1 ${t.screen}`}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <View className={`flex-row items-center gap-3 px-5 pt-14 pb-4 border-b ${t.divider}`}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8} disabled={isPending}>
          <Ionicons name="arrow-back" size={24} color={t.colors.tabBarActive} />
        </TouchableOpacity>
        <Text className={`text-xl font-bold flex-1 ${t.textPrimary}`}>New Round</Text>
        {isPending && <ActivityIndicator size="small" color={t.colors.tabBarActive} />}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Round name (optional) ────────────────────────────────────────── */}
        <View className="mb-4">
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
            Round Name <Text className={t.textTertiary}>(optional)</Text>
          </Text>
          <TextInput
            className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
            placeholder="e.g. Saturday morning round"
            placeholderTextColor={t.colors.tabBarInactive}
            value={roundName}
            onChangeText={setRoundName}
            returnKeyType="next"
            editable={!isPending}
          />
        </View>

        {/* ── Course picker ────────────────────────────────────────────────── */}
        <View className="mb-4">
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
            Course <Text className="text-red-500">*</Text>
          </Text>
          <TouchableOpacity
            className={`border rounded-xl px-4 py-3 flex-row items-center gap-3 ${t.borderInput} ${t.surfaceSunken}`}
            onPress={() => setCoursePickerVisible(true)}
            disabled={isPending}
            activeOpacity={0.7}
          >
            <View className="flex-1">
              {selectedCourse ? (
                <>
                  <Text className={`text-base ${t.textPrimary}`}>{selectedCourse.name}</Text>
                  {(selectedCourse.city || selectedCourse.state) && (
                    <Text className={`text-xs mt-0.5 ${t.textTertiary}`}>
                      {[selectedCourse.city, selectedCourse.state].filter(Boolean).join(", ")}
                    </Text>
                  )}
                </>
              ) : (
                <Text className={`text-base ${t.textTertiary}`}>Search for a course…</Text>
              )}
            </View>
            {selectedCourse ? (
              <TouchableOpacity
                onPress={() => { setSelectedCourse(null); setSelectedTeeId(null); }}
                hitSlop={8}
                disabled={isPending}
              >
                <Ionicons name="close-circle" size={18} color={t.colors.tabBarInactive} />
              </TouchableOpacity>
            ) : (
              <Ionicons name="chevron-forward" size={16} color={t.colors.tabBarInactive} />
            )}
          </TouchableOpacity>
        </View>

        {/* ── Tee picker — only shown when the course has tees ────────────── */}
        {selectedCourse && selectedCourse.tees.length > 0 && (
          <View className="mb-4">
            <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
              Tee <Text className="text-red-500">*</Text>
            </Text>
            <View className="gap-2">
              {chunk(selectedCourse.tees, 2).map((row, rowIdx) => (
                <View key={rowIdx} className="flex-row gap-2">
                  {row.map((tee) => {
                    const selected = selectedTeeId === tee.id;
                    return (
                      <TouchableOpacity
                        key={tee.id}
                        className={`flex-1 rounded-xl py-2.5 px-2 items-center border ${
                          selected
                            ? `${t.primaryBg} border-transparent`
                            : `${t.surface} ${t.borderInput}`
                        }`}
                        onPress={() => setSelectedTeeId(tee.id)}
                        disabled={isPending}
                      >
                        <Text className={`text-sm font-semibold ${selected ? "text-white" : t.textSecondary}`}>
                          {tee.name}
                        </Text>
                        <Text className={`text-xs mt-0.5 ${selected ? "text-white/80" : t.textTertiary}`}>
                          Par {tee.par} · Slope {tee.slope_rating} · {tee.course_rating}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Info chip when the course has no tees */}
        {selectedCourse && selectedCourse.tees.length === 0 && (
          <View className={`mb-4 flex-row items-center gap-2 rounded-xl px-3 py-2.5 border ${t.border}`}>
            <Ionicons name="information-circle-outline" size={16} color={t.colors.tabBarInactive} />
            <Text className={`text-xs flex-1 ${t.textTertiary}`}>
              No tees configured — a default tee will be created automatically.
            </Text>
          </View>
        )}

        {/* Warning when the course has no hole data */}
        {selectedCourse && !selectedCourse.has_holes && (
          <View className="mb-4 flex-row items-center gap-2 rounded-xl bg-amber-50 border border-amber-200 p-3">
            <Ionicons name="warning-outline" size={16} color="#d97706" />
            <Text className="text-xs text-amber-700 flex-1">
              This course has no hole data. Par and stroke index won{"'"}t be available on the scorecard.
            </Text>
          </View>
        )}

        {/* ── Date ─────────────────────────────────────────────────────────── */}
        <View className="mb-6">
          <DateInput
            label="Date"
            required
            value={scheduledDate}
            onChange={setScheduledDate}
            disabled={isPending}
            returnKeyType="done"
          />
        </View>

        {/* ── Scoring format ───────────────────────────────────────────────── */}
        <View className="mb-8">
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
            Scoring Format
          </Text>
          <View className="gap-2">
            {chunk(SCORING_FORMATS, 2).map((row, rowIdx) => (
              <View key={rowIdx} className="flex-row gap-2">
                {row.map((fmt) => {
                  const selected = scoringFormat === fmt.value;
                  return (
                    <TouchableOpacity
                      key={fmt.value}
                      className={`flex-1 rounded-xl py-3 items-center border ${
                        selected
                          ? `${t.primaryBg} border-transparent`
                          : `${t.surface} ${t.borderInput}`
                      }`}
                      onPress={() => setScoringFormat(fmt.value)}
                      disabled={isPending}
                    >
                      <Text className={`text-sm font-semibold ${selected ? "text-white" : t.textSecondary}`}>
                        {fmt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </View>
        </View>

        {/* ── Submit button ────────────────────────────────────────────────── */}
        <TouchableOpacity
          className={`rounded-2xl py-4 items-center ${isPending ? t.primaryBgDisabled : t.primaryBg}`}
          onPress={() => createMutation.mutate()}
          disabled={isPending}
          activeOpacity={0.8}
        >
          {isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text className="text-white font-bold text-base">Create Round</Text>
          )}
        </TouchableOpacity>
      </ScrollView>

      <CoursePickerModal
        visible={coursePickerVisible}
        onClose={() => setCoursePickerVisible(false)}
        onSelect={(course) => {
          setSelectedCourse(course);
          setSelectedTeeId(null);
          setCoursePickerVisible(false);
        }}
      />
    </KeyboardAvoidingView>
  );
}
