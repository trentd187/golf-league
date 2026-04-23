// app/(tabs)/courses.tsx
// Courses tab — searchable list of all courses in the database.
// Shows each course's name, location, tee count, and whether hole data exists.
// Admin/manager users see a "+ New Course" button to create a course manually.
// Tapping a course navigates to the course detail screen (courses/[id].tsx).

import { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
  Modal,

} from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useUser } from "@/hooks/useUser";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { apiFetch } from "@/utils/api";
import ModalHeader from "@/components/ModalHeader";
import type { CourseSummary } from "@/types/courses";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAdminOrManager(role: unknown): boolean {
  return role === "admin" || role === "manager";
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CoursesScreen() {
  const router       = useRouter();
  const { getToken } = useAuth();
  const { user }     = useUser();
  const t            = useTheme();
  const queryClient  = useQueryClient();

  const [searchQuery,    setSearchQuery]    = useState("");
  const [createVisible,  setCreateVisible]  = useState(false);

  const canEdit = isAdminOrManager((user?.app_metadata as { role?: string })?.role);

  // ── Fetch courses (re-fetches when searchQuery changes) ───────────────────
  const fetchCourses = useCallback(async (): Promise<CourseSummary[]> => {
    const token = await getToken();
    let url = `${API_URL}/api/v1/courses`;
    const q = searchQuery.trim();
    if (q) url += `?q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error("Failed to load courses");
    return res.json();
  }, [searchQuery, getToken]);

  const {
    data: courses,
    isLoading,
    isError,
    refetch,
  } = useQuery<CourseSummary[]>({
    queryKey: ["courses", searchQuery],
    queryFn:  fetchCourses,
  });

  // ── Create course ─────────────────────────────────────────────────────────

  const [newName,      setNewName]      = useState("");
  const [newCity,      setNewCity]      = useState("");
  const [newState,     setNewState]     = useState("");
  // holeCount can only be 9 or 18 — default 18.
  const [newHoleCount, setNewHoleCount] = useState<9 | 18>(18);

  const createMutation = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/courses`, {
        method:  "POST",
        headers: {
          Authorization:  `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name:       newName.trim(),
          city:       newCity.trim() || undefined,
          state:      newState.trim() || undefined,
          hole_count: newHoleCount,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to create course");
      }
      return res.json() as Promise<{ id: string }>;
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["courses"] });
      setCreateVisible(false);
      setNewName("");
      setNewCity("");
      setNewState("");
      setNewHoleCount(18);
      router.push(`/courses/${created.id}`);
    },
    onError: (err: Error) => {
      Alert.alert("Error", err.message);
    },
  });

  const canCreate = newName.trim().length > 0 && !createMutation.isPending;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <View className={`flex-1 ${t.screen}`}>

        {/* Header */}
        <View className="px-5 pt-14 pb-3">
          <View className="flex-row items-center justify-between mb-4">
            <Text className={`text-2xl font-bold ${t.textPrimary}`}>Courses</Text>
            {canEdit && (
              <TouchableOpacity
                className="flex-row items-center gap-1.5 bg-green-700 rounded-xl px-3 py-2"
                onPress={() => setCreateVisible(true)}
              >
                <Ionicons name="add" size={16} color="white" />
                <Text className="text-white text-sm font-semibold">New Course</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Search input */}
          <View className={`flex-row items-center border rounded-xl px-3 gap-2 ${t.borderInput} ${t.surfaceSunken}`}>
            <Ionicons name="search-outline" size={18} color={t.colors.tabBarInactive} />
            <TextInput
              className={`flex-1 py-3 text-base ${t.textPrimary}`}
              placeholder="Search by name, city, or state…"
              placeholderTextColor={t.colors.tabBarInactive}
              value={searchQuery}
              onChangeText={setSearchQuery}
              returnKeyType="search"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery("")} hitSlop={8}>
                <Ionicons name="close-circle" size={18} color={t.colors.tabBarInactive} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* List */}
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color={t.colors.tabBarActive} />
          </View>
        ) : isError ? (
          <View className="flex-1 items-center justify-center px-6">
            <Text className={`text-base text-center ${t.textSecondary}`}>
              Could not load courses. Pull down to retry.
            </Text>
          </View>
        ) : (
          <FlatList
            data={courses}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 48 }}

            ListEmptyComponent={
              <Text className={`text-sm text-center mt-10 ${t.textTertiary}`}>
                {searchQuery.trim() ? "No courses match your search." : "No courses yet."}
              </Text>
            }
            renderItem={({ item }) => (
              <TouchableOpacity
                className={`flex-row items-center border rounded-2xl px-4 py-3.5 mb-2 ${t.border} ${t.surface}`}
                onPress={() => router.push(`/courses/${item.id}`)}
                activeOpacity={0.7}
              >
                <View className="flex-1">
                  <Text className={`font-semibold text-base ${t.textPrimary}`}>{item.name}</Text>
                  <Text className={`text-xs mt-0.5 ${t.textTertiary}`}>
                    {[item.city, item.state].filter(Boolean).join(", ")}
                    {item.tee_count > 0 ? ` · ${item.tee_count} tee${item.tee_count !== 1 ? "s" : ""}` : ""}
                  </Text>
                </View>
                {/* Amber dot when no hole data */}
                {!item.has_holes && (
                  <View className="mr-2 w-2 h-2 rounded-full bg-amber-500" />
                )}
                <Ionicons name="chevron-forward" size={16} color={t.colors.tabBarInactive} />
              </TouchableOpacity>
            )}
          />
        )}
      </View>

      {/* ── Create Course Modal ─────────────────────────────────────────────── */}
      <Modal
        visible={createVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setCreateVisible(false)}
      >
        <View className={`flex-1 ${t.surface} px-5 pt-8`}>
          <ModalHeader
            title="New Course"
            onClose={() => setCreateVisible(false)}
            disabled={createMutation.isPending}
          />

          <View className="mt-6 gap-4">
            {/* Name */}
            <View>
              <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                Course Name <Text className="text-red-500">*</Text>
              </Text>
              <TextInput
                className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                placeholder="e.g. Augusta National"
                placeholderTextColor={t.colors.tabBarInactive}
                value={newName}
                onChangeText={setNewName}
                autoCapitalize="words"
                editable={!createMutation.isPending}
              />
            </View>

            {/* City */}
            <View>
              <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                City
              </Text>
              <TextInput
                className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                placeholder="e.g. Augusta"
                placeholderTextColor={t.colors.tabBarInactive}
                value={newCity}
                onChangeText={setNewCity}
                autoCapitalize="words"
                editable={!createMutation.isPending}
              />
            </View>

            {/* State */}
            <View>
              <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                State
              </Text>
              <TextInput
                className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                placeholder="e.g. GA"
                placeholderTextColor={t.colors.tabBarInactive}
                value={newState}
                onChangeText={setNewState}
                autoCapitalize="characters"
                maxLength={2}
                editable={!createMutation.isPending}
              />
            </View>

            {/* Hole count — 9 or 18 only */}
            <View>
              <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
                Holes
              </Text>
              <View className="flex-row gap-3">
                {([9, 18] as const).map((n) => (
                  <TouchableOpacity
                    key={n}
                    className={`flex-1 rounded-xl py-3 items-center border ${
                      newHoleCount === n ? `${t.primaryBg} border-transparent` : `${t.surface} ${t.borderInput}`
                    }`}
                    onPress={() => setNewHoleCount(n)}
                    disabled={createMutation.isPending}
                  >
                    <Text className={`font-semibold ${newHoleCount === n ? "text-white" : t.textSecondary}`}>
                      {n} holes
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Submit */}
            <TouchableOpacity
              className={`rounded-xl py-3.5 items-center mt-2 ${canCreate ? "bg-green-700" : "bg-green-700/40"}`}
              onPress={() => createMutation.mutate()}
              disabled={!canCreate}
            >
              {createMutation.isPending ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text className="text-white font-semibold text-base">Create Course</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}
