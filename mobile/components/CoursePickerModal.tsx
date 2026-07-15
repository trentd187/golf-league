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
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import { savePost } from "@/utils/savePost";
import { apiGet, apiGetJson } from "@/utils/apiGet";
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
  // allCourses: full unfiltered list fetched on modal open, shown when no search is active.
  const [allCourses, setAllCourses]               = useState<LocalCourseSummary[]>([]);
  const [allCoursesLoading, setAllCoursesLoading] = useState(false);
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
  // listError: the course list or search FAILED, as opposed to genuinely returning nothing.
  // Without this the two are indistinguishable — a 500 rendered as "No courses found", so the
  // user retyped a course name that was there all along, on the screen that gates round creation.
  const [listError, setListError]                 = useState(false);

  // debounceRef holds the pending timeout id so we can cancel it on the next keystroke.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset all state when the modal closes so it's clean when it opens next time.
  useEffect(() => {
    if (!visible) {
      setQuery("");
      setLocationQuery("");
      setAllCourses([]);
      setLocalResults([]);
      setExternalResults([]);
      setLocalLoading(false);
      setAllCoursesLoading(false);
      setExternalLoading(false);
      setImportingId(null);
      setSelectingId(null);
      setShowExternal(false);
      return;
    }

    // On open: load all courses alphabetically so the list is immediately browsable.
    //
    // This used to be a .then() chain with `res.ok ? res.json() : []`, an empty `.catch(() => {})`,
    // and no .catch() on the outer getToken() at all. Three failures in one: a 500 became an
    // empty course list, a transport failure became an empty course list, and a rejected
    // getToken() was an unhandled rejection whose .finally() never ran — leaving the spinner up
    // forever. On the screen that gates round creation, "no courses" and "the server is broken"
    // looked identical, and neither reached Sentry.
    let cancelled = false;
    setAllCoursesLoading(true);
    setListError(false);

    void (async () => {
      try {
        const token = await getToken();
        // apiGetJson reports a non-2xx as well as a transport exhaustion — apiGet alone
        // returns the failed Response for the caller to (previously, silently) discard.
        const data = await apiGetJson<LocalCourseSummary[]>({
          url: `${API_URL}/api/v1/courses`,
          token: token ?? "",
          label: "courses_list",
        });
        if (cancelled) return;
        setAllCourses([...data].sort((a, b) => a.name.localeCompare(b.name)));
      } catch {
        // Already reported by apiGetJson with the endpoint label and a connection snapshot.
        // Here we only need to tell the user, so an empty list can't masquerade as "no courses".
        if (!cancelled) setListError(true);
      } finally {
        if (!cancelled) setAllCoursesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // getToken is intentionally excluded from deps — same reasoning as the search effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setListError(false);
      try {
        const token = await getToken();
        // Build URL from whichever fields are filled.
        // ?name= filters by course name; ?location= does an OR across city and state.
        const params = new URLSearchParams();
        if (query.trim())        params.set("name",     query.trim());
        if (locationQuery.trim()) params.set("location", locationQuery.trim());
        const url = `${API_URL}/api/v1/courses?${params.toString()}`;
        const data = await apiGetJson<LocalCourseSummary[]>({
          url,
          token: token ?? "",
          label: "courses_search",
        });
        setLocalResults(
          Array.isArray(data) ? [...data].sort((a, b) => a.name.localeCompare(b.name)) : [],
        );
      } catch {
        // Reported by apiGetJson. Surface it: a failed search used to render as "no results",
        // which is indistinguishable from a genuinely empty result set — so the user would
        // keep retyping a course name that was there all along.
        setListError(true);
      } finally {
        setLocalLoading(false);
      }
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // getToken is intentionally excluded: it is called inside an async callback,
    // not synchronously in the effect body. Including it would cause an infinite
    // loop because useAuth creates a new function reference on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, locationQuery]);

  // ── External search — only called when the user explicitly taps "Search Online" ─
  const searchExternal = async () => {
    if (!query.trim()) return;
    setExternalLoading(true);
    setShowExternal(true);
    try {
      const token = await getToken();
      // A READ-shaped POST: /courses/search-external is a query in everything but HTTP verb
      // (it creates nothing — importing is a separate call). Routing it through apiGet gives
      // it the timeout + jittered retry + read telemetry every other read has, and skips the
      // Idempotency-Key a real create needs. It was the last bare fetch() in the app: an
      // external course search over a hotel/clubhouse wifi could hang forever with no signal.
      const res = await apiGet({
        url: `${API_URL}/api/v1/courses/search-external`,
        token: token ?? "",
        method: "POST",
        body: {
          search: query.trim(),
          location: locationQuery.trim() || undefined,
        },
        label: "course_search_external",
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
  // Throws (a reported ApiError) on failure rather than returning null on a non-2xx, so the
  // caller can't confuse "the course has no tees" with "the request failed".
  const fetchCourseDetail = async (courseId: string): Promise<PickedCourse> => {
    const token = await getToken();
    const data = await apiGetJson<CourseDetailResponse>({
      url: `${API_URL}/api/v1/courses/${courseId}`,
      token: token ?? "",
      label: "course_detail",
    });
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
  //
  // The catch is load-bearing: fetchCourseDetail throws on a transport exhaustion, and this
  // runs from an onPress — so without it the rejection escaped as an unhandled promise, the
  // row simply stopped spinning, and the user was told nothing at all.
  const selectLocal = async (course: LocalCourseSummary) => {
    setSelectingId(course.id);
    try {
      onSelect(await fetchCourseDetail(course.id));
    } catch {
      // Already reported by apiGetJson (labelled + connection snapshot); just tell the user.
      Alert.alert("Error", "Could not load course details. Please try again.");
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
      // savePost: import-external is durable-idempotency wrapped (backend), so a phantom
      // (commit + lost ack) retry replays the imported course instead of duplicating it.
      const imported = await savePost<CourseDetailResponse>({
        url: `${API_URL}/api/v1/courses/import-external`,
        token: token ?? "",
        body: { external_id: external.external_id },
        label: "course-import",
      });
      onSelect({
        id: imported.id,
        name: imported.name,
        city: imported.city ?? "",
        state: imported.state ?? "",
        hole_count: imported.hole_count ?? 18,
        has_holes: imported.has_holes ?? false,
        tees: imported.tees ?? [],
      });
    } catch (err) {
      Alert.alert("Import failed", err instanceof Error ? err.message : "Check your connection and try again.");
    } finally {
      setImportingId(null);
    }
  };

  // ── Derived values ───────────────────────────────────────────────────────────

  // hasSearch: true when the user has typed enough in either field to trigger a search.
  const hasSearch      = query.trim().length >= 3 || locationQuery.trim().length >= 2;
  // canSearchOnline: external API requires a course name (location-only searches aren't supported).
  const canSearchOnline = query.trim().length >= 3;
  // A failed search is NOT "no results" — listError gates this so the two never look alike.
  const noLocalResults = hasSearch && !localLoading && !listError && localResults.length === 0;
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
          data={hasSearch ? localResults : allCourses}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 }}
          ListHeaderComponent={
            <>
              {/* Spinner while loading all courses on open */}
              {allCoursesLoading && !hasSearch && (
                <ActivityIndicator
                  size="small"
                  color={t.colors.tabBarActive}
                  style={{ marginVertical: 20 }}
                />
              )}
              {/* Spinner while a search is in flight */}
              {localLoading && hasSearch && (
                <ActivityIndicator
                  size="small"
                  color={t.colors.tabBarActive}
                  style={{ marginVertical: 20 }}
                />
              )}
              {/* The request FAILED — say so, rather than rendering it as "no courses". */}
              {listError && !allCoursesLoading && !localLoading && (
                <Text className="text-sm text-center mt-10 text-red-600">
                  Couldn&apos;t load courses. Check your connection and try again.
                </Text>
              )}
              {/* Hint text — only shown after initial load when no courses exist at all */}
              {!listError && !allCoursesLoading && !hasSearch && allCourses.length === 0 && (
                <Text className={`text-sm text-center mt-10 ${t.textTertiary}`}>
                  No courses yet. Type a name to search online.
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
