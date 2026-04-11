// components/CoursePickerModal.tsx
// Full-screen modal for searching and selecting a golf course before scheduling a round.
//
// Search strategy (minimising external API calls):
//   1. Local-first  — debounced query to GET /api/v1/courses?name=&location=... (our DB, no cost).
//      Triggers when course name has 3+ chars OR location has 2+ chars.
//   2. External on-demand — "Search Online" button calls POST /courses/search-external
//      (one GolfCourseAPI call per user tap).
//   3. Auto-import on select — tapping an external result calls POST /courses/import-external
//      (one more call), then the course lives in our DB for all future rounds at no extra cost.
//
// The parent receives a PickedCourse value that includes the tee list so it can render
// a tee picker without making another network request.

import { useState, useEffect, useRef } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
} from "react-native";

import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@clerk/clerk-expo";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import ModalHeader from "@/components/ModalHeader";

// ─── Exported types ────────────────────────────────────────────────────────────

export interface CourseTeeSummary {
  id: string;
  name: string;
  course_rating: number;
  slope_rating: number;
  par: number;
}

// PickedCourse is returned to the parent when the user selects a course.
// It includes tees so the parent can show a tee picker without a second fetch.
// has_holes is true when at least one tee has all 18 holes populated — used
// to warn the organizer before scheduling on an incomplete course.
// hole_count is 9 or 18 — used by the schedule form to show the front/back nine selector.
export interface PickedCourse {
  id: string;
  name: string;
  city: string;
  state: string;
  hole_count: number;
  has_holes: boolean;
  tees: CourseTeeSummary[];
}

// ─── Internal types ─────────────────────────────────────────────────────────

interface LocalCourseSummary {
  id: string;
  name: string;
  city: string;
  state: string;
  tee_count: number;
  has_holes: boolean;
}

interface ExternalCourseSummary {
  external_id: string;
  name: string;
  city: string;
  state: string;
  tee_count: number;
}

// CourseDetailResponse shape returned by GET /courses/:id and POST /courses/import-external.
interface CourseDetailResponse {
  id: string;
  name: string;
  city: string;
  state: string;
  hole_count: number;
  has_holes: boolean;
  tees: CourseTeeSummary[];
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface CoursePickerModalProps {
  visible: boolean;
  onClose: () => void;
  // Called when user finalises a selection (local or imported).
  // Parent is responsible for closing the modal after receiving this callback.
  onSelect: (course: PickedCourse) => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function CoursePickerModal({
  visible,
  onClose,
  onSelect,
}: CoursePickerModalProps) {
  const { getToken } = useAuth();
  const t = useTheme();

  const [query, setQuery]                         = useState("");
  // locationQuery: optional city, state, or zip — appended to external search and used
  // to filter local DB results by city or state.
  const [locationQuery, setLocationQuery]         = useState("");
  const [localResults, setLocalResults]           = useState<LocalCourseSummary[]>([]);
  const [externalResults, setExternalResults]     = useState<ExternalCourseSummary[]>([]);
  const [localLoading, setLocalLoading]           = useState(false);
  const [externalLoading, setExternalLoading]     = useState(false);
  // importingId: external_id currently being imported, or null. Prevents double-taps.
  const [importingId, setImportingId]             = useState<string | null>(null);
  // selecting: true while fetching course detail after a local result tap.
  const [selectingId, setSelectingId]             = useState<string | null>(null);
  // showExternal: true once the user has tapped "Search Online" for the current query.
  const [showExternal, setShowExternal]           = useState(false);

  // debounceRef holds the pending timeout id so we can cancel it on the next keystroke.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset all state when the modal closes so it's clean when it opens next time.
  useEffect(() => {
    if (!visible) {
      setQuery("");
      setLocationQuery("");
      setLocalResults([]);
      setExternalResults([]);
      setLocalLoading(false);
      setExternalLoading(false);
      setImportingId(null);
      setSelectingId(null);
      setShowExternal(false);
    }
  }, [visible]);

  // ── Local search — fires 500 ms after the user stops typing ─────────────────
  // Runs on both query and locationQuery changes so filtering updates when either field changes.
  // Triggers when either the course name has 4+ chars OR the location has 2+ chars — so
  // typing just "MI" or "Grand Rapids" in the location field returns results without needing
  // a course name first.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const nameReady = query.trim().length >= 3;
    const locReady  = locationQuery.trim().length >= 2;

    if (!nameReady && !locReady) {
      setLocalResults([]);
      setLocalLoading(false);
      return;
    }

    setLocalLoading(true);
    // Reset external section when the search query changes.
    setShowExternal(false);
    setExternalResults([]);

    debounceRef.current = setTimeout(async () => {
      try {
        const token = await getToken();
        // Build URL from whichever fields are filled.
        // ?name= filters by course name; ?location= does an OR across city and state.
        const params = new URLSearchParams();
        if (query.trim())        params.set("name",     query.trim());
        if (locationQuery.trim()) params.set("location", locationQuery.trim());
        let url = `${API_URL}/api/v1/courses?${params.toString()}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const data = await res.json();
          setLocalResults(Array.isArray(data) ? data : []);
        }
      } catch {
        // Network error — show empty results; user can try again or search online.
      } finally {
        setLocalLoading(false);
      }
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // getToken is intentionally excluded: it is called inside an async callback,
    // not synchronously in the effect body. Including it would cause an infinite
    // loop because Clerk creates a new function reference on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, locationQuery]);

  // ── External search — only called when the user explicitly taps "Search Online" ─
  const searchExternal = async () => {
    if (!query.trim()) return;
    setExternalLoading(true);
    setShowExternal(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/courses/search-external`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          search: query.trim(),
          location: locationQuery.trim() || undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setExternalResults(Array.isArray(data) ? data : []);
      } else {
        // Read the backend error message so the user sees what actually went wrong
        // (e.g. "GOLF_COURSE_API_KEY is not configured" or "API returned 401: ...").
        const body = await res.json().catch(() => ({}));
        const msg = (body as { error?: string }).error ?? `Server error (${res.status})`;
        Alert.alert("Search failed", msg);
      }
    } catch {
      Alert.alert("Search failed", "Check your connection and try again.");
    } finally {
      setExternalLoading(false);
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // fetchCourseDetail: called after selecting a local result to get tees.
  const fetchCourseDetail = async (courseId: string): Promise<PickedCourse | null> => {
    const token = await getToken();
    const res = await fetch(`${API_URL}/api/v1/courses/${courseId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data: CourseDetailResponse = await res.json();
    return {
      id: data.id,
      name: data.name,
      city: data.city ?? "",
      state: data.state ?? "",
      hole_count: data.hole_count ?? 18,
      has_holes: data.has_holes ?? false,
      tees: data.tees ?? [],
    };
  };

  // selectLocal: user tapped a result from the local DB.
  const selectLocal = async (course: LocalCourseSummary) => {
    setSelectingId(course.id);
    try {
      const detail = await fetchCourseDetail(course.id);
      if (detail) {
        onSelect(detail);
      } else {
        Alert.alert("Error", "Could not load course details. Please try again.");
      }
    } finally {
      setSelectingId(null);
    }
  };

  // importAndSelect: user tapped an external result — import it then return course detail.
  // After import, the course is in our DB and won't require another external call.
  const importAndSelect = async (external: ExternalCourseSummary) => {
    setImportingId(external.external_id);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/v1/courses/import-external`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ external_id: external.external_id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        Alert.alert("Import failed", (body as { error?: string }).error ?? "Could not import course.");
        return;
      }
      const imported: CourseDetailResponse = await res.json();
      onSelect({
        id: imported.id,
        name: imported.name,
        city: imported.city ?? "",
        state: imported.state ?? "",
        hole_count: imported.hole_count ?? 18,
        has_holes: imported.has_holes ?? false,
        tees: imported.tees ?? [],
      });
    } catch {
      Alert.alert("Import failed", "Check your connection and try again.");
    } finally {
      setImportingId(null);
    }
  };

  // ── Derived values ───────────────────────────────────────────────────────────

  // hasSearch: true when the user has typed enough in either field to trigger a search.
  const hasSearch      = query.trim().length >= 3 || locationQuery.trim().length >= 2;
  // canSearchOnline: external API requires a course name (location-only searches aren't supported).
  const canSearchOnline = query.trim().length >= 3;
  const noLocalResults = hasSearch && !localLoading && localResults.length === 0;
  const busy           = !!importingId || !!selectingId;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className={`flex-1 ${t.surface}`}>

        {/* Header + search input */}
        <View className="px-5 pt-8 pb-2">
          <ModalHeader title="Select Course" onClose={onClose} disabled={busy} />

          <View className={`flex-row items-center border rounded-xl px-3 mt-4 gap-2 ${t.borderInput} ${t.surfaceSunken}`}>
            <Ionicons name="search-outline" size={18} color={t.colors.tabBarInactive} />
            <TextInput
              className={`flex-1 py-3 text-base ${t.textPrimary}`}
              placeholder="Search courses by name…"
              placeholderTextColor={t.colors.tabBarInactive}
              value={query}
              onChangeText={setQuery}
              autoFocus
              returnKeyType="search"
              editable={!busy}
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={() => setQuery("")} hitSlop={8} disabled={busy}>
                <Ionicons name="close-circle" size={18} color={t.colors.tabBarInactive} />
              </TouchableOpacity>
            )}
          </View>

          {/* Optional location filter — city or state abbreviation */}
          <View className={`flex-row items-center border rounded-xl px-3 mt-2 gap-2 ${t.borderInput} ${t.surfaceSunken}`}>
            <Ionicons name="location-outline" size={18} color={t.colors.tabBarInactive} />
            <TextInput
              className={`flex-1 py-2.5 text-base ${t.textPrimary}`}
              placeholder="City or state (optional)"
              placeholderTextColor={t.colors.tabBarInactive}
              value={locationQuery}
              onChangeText={setLocationQuery}
              returnKeyType="search"
              editable={!busy}
            />
            {locationQuery.length > 0 && (
              <TouchableOpacity onPress={() => setLocationQuery("")} hitSlop={8} disabled={busy}>
                <Ionicons name="close-circle" size={18} color={t.colors.tabBarInactive} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Results list */}
        <FlatList
          data={localResults}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 }}
          ListHeaderComponent={
            <>
              {/* Spinner while local search is in flight */}
              {localLoading && (
                <ActivityIndicator
                  size="small"
                  color={t.colors.tabBarActive}
                  style={{ marginVertical: 20 }}
                />
              )}
              {/* Prompt before the user has typed enough */}
              {!localLoading && !hasSearch && (
                <Text className={`text-sm text-center mt-10 ${t.textTertiary}`}>
                  Type a course name (3+ chars) or location (2+ chars) to search
                </Text>
              )}
            </>
          }
          ListFooterComponent={
            // Footer is shown whenever a search is active (with or without local results).
            // "Search Online" is always offered so users can find courses not yet in the DB.
            hasSearch && !localLoading ? (
              <View className="mt-2">
                {/* "No local results" message — only when search returned nothing */}
                {noLocalResults && (
                  <Text className={`text-sm text-center mb-4 ${t.textTertiary}`}>
                    No courses found in your database.
                  </Text>
                )}

                {!showExternal ? (
                  // External API requires a course name — show a hint if only location was entered.
                  canSearchOnline ? (
                    <TouchableOpacity
                      className={`flex-row items-center justify-center gap-2 border rounded-xl py-3 px-4 mt-2 ${t.borderInput}`}
                      onPress={searchExternal}
                      disabled={busy}
                    >
                      <Ionicons name="globe-outline" size={18} color={t.colors.tabBarActive} />
                      {/* eslint-disable-next-line react-native/no-inline-styles */}
                      <Text className="font-semibold text-sm" style={{ color: t.colors.tabBarActive }}>
                        Search Online
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <Text className={`text-xs text-center ${t.textTertiary}`}>
                      Add a course name to search online.
                    </Text>
                  )
                ) : (
                  /* External results section */
                  <>
                    {externalLoading && (
                      <ActivityIndicator
                        size="small"
                        color={t.colors.tabBarActive}
                        style={{ marginVertical: 12 }}
                      />
                    )}
                    {!externalLoading && externalResults.length === 0 && (
                      <Text className={`text-sm text-center ${t.textTertiary}`}>
                        No results found online.
                      </Text>
                    )}
                    {externalResults.map((ext) => (
                      <TouchableOpacity
                        key={ext.external_id}
                        className={`flex-row items-center border rounded-xl px-4 py-3 mb-2 ${t.border}`}
                        onPress={() => importAndSelect(ext)}
                        disabled={busy}
                        activeOpacity={0.7}
                      >
                        <View className="flex-1">
                          <Text className={`font-semibold ${t.textPrimary}`}>{ext.name}</Text>
                          <Text className={`text-xs mt-0.5 ${t.textTertiary}`}>
                            {[ext.city, ext.state].filter(Boolean).join(", ")}
                            {ext.tee_count > 0 ? ` · ${ext.tee_count} tees` : ""}
                          </Text>
                        </View>
                        {importingId === ext.external_id ? (
                          <ActivityIndicator size="small" color={t.colors.tabBarActive} />
                        ) : (
                          <Ionicons
                            name="cloud-download-outline"
                            size={18}
                            color={t.colors.tabBarActive}
                          />
                        )}
                      </TouchableOpacity>
                    ))}
                  </>
                )}
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              className={`flex-row items-center border rounded-xl px-4 py-3 mb-2 ${t.border}`}
              onPress={() => selectLocal(item)}
              disabled={busy}
              activeOpacity={0.7}
            >
              <View className="flex-1">
                <Text className={`font-semibold ${t.textPrimary}`}>{item.name}</Text>
                <Text className={`text-xs mt-0.5 ${t.textTertiary}`}>
                  {[item.city, item.state].filter(Boolean).join(", ")}
                  {item.tee_count > 0 ? ` · ${item.tee_count} tees` : " · No tees configured"}
                </Text>
              </View>
              {selectingId === item.id ? (
                <ActivityIndicator size="small" color={t.colors.tabBarActive} />
              ) : (
                <Ionicons name="chevron-forward" size={16} color={t.colors.tabBarInactive} />
              )}
            </TouchableOpacity>
          )}
        />

      </View>
    </Modal>
  );
}
