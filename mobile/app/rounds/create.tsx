// app/rounds/create.tsx
// New-round creation screen — accessible from the "Create" button on the My Rounds tab.
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
import { useRoundForm } from "@/hooks/useRoundForm";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import { showAlert } from "@/utils/alerts";
import { buildRoundCoursePayload } from "@/utils/roundPayload";
import DateInput, { displayToApi } from "@/components/DateInput";
import CoursePickerModal from "@/components/CoursePickerModal";
import RoundFormFields from "@/components/RoundFormFields";

export default function CreateRoundScreen() {
  const t = useTheme();
  const router = useRouter();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const [roundName, setRoundName] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");

  const form = useRoundForm();

  const createMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();

      if (!scheduledDate) throw new Error("Please enter a date.");
      const apiDate = displayToApi(scheduledDate);
      if (!apiDate) throw new Error("Invalid date — use MM-DD-YY format.");
      if (!form.selectedCourse) throw new Error("Please select a golf course.");
      if (form.selectedCourse.tees.length > 0 && !form.selectedTeeId) {
        throw new Error("Please select a tee set for this course.");
      }

      const payload: Record<string, unknown> = {
        scheduled_date: apiDate,
        ...buildRoundCoursePayload(
          form.selectedCourse,
          form.selectedTeeId,
          form.nineHoleSelection,
          form.scoringFormat,
          { birdieFlip: form.vegasBirdieFlip, scoringBasis: form.vegasScoringBasis },
          { scoringBasis: form.bestBallScoringBasis },
        ),
      };
      if (roundName.trim()) payload.name = roundName.trim();

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

        {/* ── Course, tee, nine-hole, scoring format ───────────────────────── */}
        <RoundFormFields
          selectedCourse={form.selectedCourse}
          selectedTeeId={form.selectedTeeId}
          nineHoleSelection={form.nineHoleSelection}
          scoringFormat={form.scoringFormat}
          vegasBirdieFlip={form.vegasBirdieFlip}
          vegasScoringBasis={form.vegasScoringBasis}
          bestBallScoringBasis={form.bestBallScoringBasis}
          isPending={isPending}
          onOpenCoursePicker={() => form.setCoursePickerVisible(true)}
          onClearCourse={() => { form.setSelectedCourse(null); form.setSelectedTeeId(null); }}
          onSelectTee={form.setSelectedTeeId}
          onChangeNineHoles={form.setNineHoleSelection}
          onChangeScoringFormat={form.setScoringFormat}
          onChangeVegasBirdieFlip={form.setVegasBirdieFlip}
          onChangeVegasScoringBasis={form.setVegasScoringBasis}
          onChangeBestBallScoringBasis={form.setBestBallScoringBasis}
        />

        {/* ── Date ─────────────────────────────────────────────────────────── */}
        <View className="mb-8">
          <DateInput
            label="Date"
            required
            value={scheduledDate}
            onChange={setScheduledDate}
            disabled={isPending}
            returnKeyType="done"
          />
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
        visible={form.coursePickerVisible}
        onClose={() => form.setCoursePickerVisible(false)}
        onSelect={(course) => {
          form.setSelectedCourse(course);
          form.setSelectedTeeId(null);
          form.setNineHoleSelection("18");
          form.setCoursePickerVisible(false);
        }}
      />
    </KeyboardAvoidingView>
  );
}
