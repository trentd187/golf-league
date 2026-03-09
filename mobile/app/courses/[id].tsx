// app/courses/[id].tsx
// Course detail screen — shows course info, tee sets, and hole data (scorecard).
// All users can view; admin/manager users see edit controls for the course, tees, and holes.
//
// Tapping a tee row expands it inline to show the HoleDataGrid for that tee.
// Admin/manager can add tees (TeeForm), edit tees (TeeForm pre-filled), delete tees,
// edit the course name/location, and refresh from the external API if the course was imported.

import { useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth, useUser } from "@clerk/clerk-expo";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import HoleDataGrid from "@/components/HoleDataGrid";
import TeeForm from "@/components/TeeForm";
import type { CourseDetail, TeeDetail } from "@/types/courses";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// isAdminOrManager returns true for users who can edit course data.
// Role is stored in Clerk public metadata and available via useUser.
function isAdminOrManager(role: unknown): boolean {
  return role === "admin" || role === "manager";
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CourseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router  = useRouter();
  const { getToken } = useAuth();
  const { user }     = useUser();
  const t            = useTheme();
  const queryClient  = useQueryClient();

  // expandedTeeId: which tee row has its hole grid open (null = none).
  const [expandedTeeId,    setExpandedTeeId]    = useState<string | null>(null);
  // teeFormVisible / teeFormTarget: create (null) or edit (TeeDetail) mode.
  const [teeFormVisible,   setTeeFormVisible]   = useState(false);
  const [teeFormTarget,    setTeeFormTarget]    = useState<TeeDetail | null>(null);
  const [deletingTeeId,    setDeletingTeeId]    = useState<string | null>(null);
  const [refreshingCourse, setRefreshingCourse] = useState(false);

  const canEdit = isAdminOrManager(user?.publicMetadata?.role);

  // ── Data fetching ──────────────────────────────────────────────────────────
  const fetchCourse = useCallback(async (): Promise<CourseDetail> => {
    const token = await getToken();
    const res = await fetch(`${API_URL}/api/v1/courses/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Failed to load course");
    return res.json();
  }, [id, getToken]);

  const {
    data: course,
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useQuery<CourseDetail>({
    queryKey: ["course", id],
    queryFn:  fetchCourse,
    enabled:  !!id,
  });

  const invalidateCourse = () => {
    queryClient.invalidateQueries({ queryKey: ["course", id] });
    queryClient.invalidateQueries({ queryKey: ["courses"] });
  };

  // ── Tee delete ─────────────────────────────────────────────────────────────
  const deleteTee = (tee: TeeDetail) => {
    Alert.alert(
      `Delete "${tee.name}" tee?`,
      "This will also delete all hole data for this tee. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeletingTeeId(tee.id);
            try {
              const token = await getToken();
              const res = await fetch(
                `${API_URL}/api/v1/courses/${id}/tees/${tee.id}`,
                { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
              );
              if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                Alert.alert("Error", (body as { error?: string }).error ?? "Could not delete tee.");
                return;
              }
              if (expandedTeeId === tee.id) setExpandedTeeId(null);
              invalidateCourse();
            } catch {
              Alert.alert("Error", "Check your connection and try again.");
            } finally {
              setDeletingTeeId(null);
            }
          },
        },
      ],
    );
  };

  // ── External API refresh ──────────────────────────────────────────────────
  const refreshFromAPI = async () => {
    setRefreshingCourse(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/courses/${id}/refresh`, {
        method:  "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        Alert.alert("Refresh failed", (body as { error?: string }).error ?? "Could not refresh.");
        return;
      }
      invalidateCourse();
      Alert.alert("Refreshed", "Course data updated from external source.");
    } catch {
      Alert.alert("Refresh failed", "Check your connection and try again.");
    } finally {
      setRefreshingCourse(false);
    }
  };

  // ── Loading / error states ─────────────────────────────────────────────────
  if (isLoading) {
    return (
      <View className={`flex-1 items-center justify-center ${t.screen}`}>
        <ActivityIndicator size="large" color={t.colors.tabBarActive} />
      </View>
    );
  }

  if (isError || !course) {
    return (
      <View className={`flex-1 items-center justify-center px-6 ${t.screen}`}>
        <Text className={`text-base text-center ${t.textSecondary}`}>
          Could not load course. Pull down to retry.
        </Text>
        <TouchableOpacity className="mt-4" onPress={() => refetch()}>
          <Text className="text-green-700 font-semibold">Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <>
      <ScrollView
        className={`flex-1 ${t.screen}`}
        contentContainerStyle={{ paddingBottom: 48 }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={t.colors.tabBarActive}
          />
        }
      >
        {/* ── Back + Header ──────────────────────────────────────────────── */}
        <View className="px-5 pt-14 pb-4">
          <TouchableOpacity
            className="flex-row items-center gap-1 mb-3"
            onPress={() => router.back()}
          >
            <Ionicons name="chevron-back" size={18} color={t.colors.tabBarActive} />
            {/* eslint-disable-next-line react-native/no-inline-styles */}
            <Text className="text-sm font-semibold" style={{ color: t.colors.tabBarActive }}>
              Courses
            </Text>
          </TouchableOpacity>

          <Text className={`text-2xl font-bold ${t.textPrimary}`}>{course.name}</Text>
          {(course.city || course.state) && (
            <Text className={`text-sm mt-1 ${t.textTertiary}`}>
              {[course.city, course.state].filter(Boolean).join(", ")}
            </Text>
          )}
          <Text className={`text-xs mt-1 ${t.textTertiary}`}>
            {course.hole_count}-hole course
          </Text>

          {/* has_holes warning */}
          {!course.has_holes && (
            <View className="mt-3 flex-row items-center gap-2 rounded-xl bg-amber-50 border border-amber-200 p-3">
              <Ionicons name="warning-outline" size={16} color="#d97706" />
              <Text className="text-xs text-amber-700 flex-1">
                No hole data. Add tees and enter hole data before scheduling rounds.
              </Text>
            </View>
          )}
        </View>

        {/* ── Tees Section ───────────────────────────────────────────────── */}
        <View className="px-5">
          <View className="flex-row items-center justify-between mb-3">
            <Text className={`text-xs font-semibold uppercase tracking-widest ${t.textTertiary}`}>
              Tees
            </Text>
            {/* Add Tee button for admin/manager */}
            {canEdit && (
              <TouchableOpacity
                className="flex-row items-center gap-1"
                onPress={() => {
                  setTeeFormTarget(null);
                  setTeeFormVisible(true);
                }}
              >
                <Ionicons name="add-circle-outline" size={16} color={t.colors.tabBarActive} />
                {/* eslint-disable-next-line react-native/no-inline-styles */}
                <Text className="text-sm font-semibold" style={{ color: t.colors.tabBarActive }}>
                  Add Tee
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {course.tees.length === 0 && (
            <Text className={`text-sm ${t.textTertiary} mb-4`}>
              No tees configured yet.{canEdit ? ' Tap \u201c+ Add Tee\u201d to get started.' : ""}
            </Text>
          )}

          {course.tees.map((tee) => {
            const isExpanded   = expandedTeeId === tee.id;
            const isDeleting   = deletingTeeId === tee.id;

            return (
              <View
                key={tee.id}
                className={`border rounded-2xl mb-3 overflow-hidden ${t.border}`}
              >
                {/* Tee row header — tap to expand/collapse hole grid */}
                <TouchableOpacity
                  className={`flex-row items-center px-4 py-3 ${t.surface}`}
                  onPress={() => setExpandedTeeId(isExpanded ? null : tee.id)}
                  activeOpacity={0.7}
                >
                  <View className="flex-1">
                    <Text className={`font-semibold text-base ${t.textPrimary}`}>{tee.name}</Text>
                    <Text className={`text-xs mt-0.5 ${t.textTertiary}`}>
                      Rating {tee.course_rating} · Slope {tee.slope_rating} · Par {tee.par}
                    </Text>
                  </View>
                  {/* Edit / Delete — admin/manager only */}
                  {canEdit && (
                    <View className="flex-row items-center gap-3 mr-2">
                      <TouchableOpacity
                        hitSlop={8}
                        onPress={() => {
                          setTeeFormTarget(tee);
                          setTeeFormVisible(true);
                        }}
                      >
                        <Ionicons name="create-outline" size={18} color={t.colors.tabBarActive} />
                      </TouchableOpacity>
                      <TouchableOpacity hitSlop={8} onPress={() => deleteTee(tee)} disabled={isDeleting}>
                        {isDeleting ? (
                          <ActivityIndicator size="small" color="#dc2626" />
                        ) : (
                          <Ionicons name="trash-outline" size={18} color="#dc2626" />
                        )}
                      </TouchableOpacity>
                    </View>
                  )}
                  <Ionicons
                    name={isExpanded ? "chevron-up" : "chevron-down"}
                    size={16}
                    color={t.colors.tabBarInactive}
                  />
                </TouchableOpacity>

                {/* Hole data grid — only visible when this tee is expanded */}
                {isExpanded && (
                  <View className={`px-4 pb-4 pt-2 ${t.surfaceSunken}`}>
                    <HoleDataGrid
                      courseId={id!}
                      teeId={tee.id}
                      holes={tee.holes}
                      editable={canEdit}
                      onSaved={invalidateCourse}
                    />
                  </View>
                )}
              </View>
            );
          })}
        </View>

        {/* ── Admin actions ──────────────────────────────────────────────── */}
        {canEdit && course.external_source && (
          <View className="px-5 mt-4">
            <TouchableOpacity
              className={`flex-row items-center justify-center gap-2 border rounded-xl py-3 ${t.borderInput}`}
              onPress={refreshFromAPI}
              disabled={refreshingCourse}
            >
              {refreshingCourse ? (
                <ActivityIndicator size="small" color={t.colors.tabBarActive} />
              ) : (
                <Ionicons name="refresh-outline" size={16} color={t.colors.tabBarActive} />
              )}
              {/* eslint-disable-next-line react-native/no-inline-styles */}
              <Text className="text-sm font-semibold" style={{ color: t.colors.tabBarActive }}>
                Refresh from API
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* ── Tee Form Modal ─────────────────────────────────────────────────── */}
      <TeeForm
        visible={teeFormVisible}
        onClose={() => setTeeFormVisible(false)}
        courseId={id!}
        existing={teeFormTarget}
        onSaved={invalidateCourse}
      />
    </>
  );
}
