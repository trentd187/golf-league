// app/(tabs)/profile.tsx
// The Profile screen — shows the signed-in user's information and lets them:
//   1. Upload or change their profile photo (stored in Supabase Storage, avatars bucket)
//   2. Edit their display name (stored in Supabase user_metadata)
//   3. Browse players they follow (with quick links to each profile)
//   4. Switch the app theme (Light, Dark, Colorful, Grey)
//   5. Sign out
//
// Role is fetched from GET /api/v1/me because it lives only in our PostgreSQL DB,
// not in the Supabase JWT (role is a DB-managed field to prevent self-elevation).
//
// Profile photo flow:
//   - Tap the avatar → expo-image-picker opens the photo library
//   - User selects a photo → uploaded directly to Supabase Storage (avatars bucket)
//   - avatar_url is saved to user_metadata via supabase.auth.updateUser()

import { useUser } from "@/hooks/useUser";
import { useAuth } from "@/hooks/useAuth";
import { useMe } from "@/hooks/useMe";
import { supabase } from "@/utils/supabase";
import { apiFetch } from "@/utils/api";
import { API_URL } from "@/constants/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import UserAvatar from "@/components/UserAvatar";
import * as ImagePicker from "expo-image-picker";
import {
  Text,
  View,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  TextInput,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  Image,
  Switch,
} from "react-native";
import { useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { useThemeStore } from "@/stores/themeStore";
import { THEME_META } from "@/themes";
import { getTelemetryClient } from "@/utils/telemetry";
import {
  type ScorecardSettings,
  DEFAULT_SCORECARD_SETTINGS,
} from "@/types/scorecard";
import { moveStatUp, moveStatDown } from "@/utils/scorecard";

// ─── Sub-components ───────────────────────────────────────────────────────────

// SystemRoleBadge renders a small coloured pill showing the user's platform-level role.
// Role colors are categorical — hardcoded and NOT affected by the theme.
function SystemRoleBadge({ role }: { role?: string }) {
  const styles: Record<string, { bg: string; text: string; label: string }> = {
    admin: { bg: "bg-green-100", text: "text-green-700", label: "Admin" },
    user:  { bg: "bg-gray-100",  text: "text-gray-600",  label: "User" },
  };
  const style = styles[role ?? ""] ?? styles.user;
  const label = styles[role ?? ""]?.label ?? "User";
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${style.bg}`}>
      <Text className={`text-xs font-semibold ${style.text}`}>{label}</Text>
    </View>
  );
}

// STAT_META maps each stat key to its human-readable label in the settings UI.
// Module-level so it isn't recreated on every render.
const STAT_META: Record<string, string> = {
  fir:                 "Fairway (FIR)",
  gir:                 "Green (GIR)",
  putts:               "Putts",
  first_putt_distance: "First Putt Distance",
  putt_distance_made:  "Made Putt Distance",
  approach_yds:        "Approach Yards",
  tee_shot_club:       "Tee Shot Club",
  tee_shot_distance:   "Tee Shot Distance",
};

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const { user, loading: userLoading } = useUser();
  const { signOut, getToken } = useAuth();
  const { data: meData } = useMe();
  const router = useRouter();
  const t = useTheme();
  const queryClient = useQueryClient();

  // Fetch the list of users this player is following so they appear in the profile.
  const { data: following, isLoading: followingLoading } = useQuery({
    queryKey: ["users", "following"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/users/following`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load following list");
      return res.json() as Promise<
        { id: string; display_name: string; avatar_url: string | null; rounds_played: number }[]
      >;
    },
    // Only fetch once the Supabase session is ready (user is truthy).
    enabled: !!user,
  });

  const { data: scorecardSettings } = useQuery<ScorecardSettings>({
    queryKey: ["scorecardSettings"],
    queryFn: async () => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/users/me/scorecard-settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to load scorecard settings");
      return res.json();
    },
    enabled: !!user,
  });

  const settingsMutation = useMutation({
    mutationFn: async (next: ScorecardSettings) => {
      const token = await getToken();
      const res = await apiFetch(`${API_URL}/api/v1/users/me/scorecard-settings`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error("Failed to save scorecard settings");
      return res.json() as Promise<ScorecardSettings>;
    },
    // Optimistically update the cache so the toggle feels instant.
    onSuccess: (_, next) => {
      queryClient.setQueryData<ScorecardSettings>(["scorecardSettings"], next);
    },
  });

  // Merge with defaults so partial or missing data (e.g. old server responses without
  // stat_order) still produces a fully-shaped ScorecardSettings object.
  const settings: ScorecardSettings = { ...DEFAULT_SCORECARD_SETTINGS, ...(scorecardSettings as Partial<ScorecardSettings> | undefined) };

  // Why two separate useThemeStore calls instead of one selector returning an object?
  // A selector like `(s) => ({ themeName, setTheme })` creates a new object on every
  // render. React 19's useSyncExternalStore compares snapshots by reference — a new
  // object every time looks like a change, causing an infinite re-render loop.
  const themeName = useThemeStore((s) => s.themeName);
  const setTheme = useThemeStore((s) => s.setTheme);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  // localPhotoUri: displayed immediately after picking so the avatar updates without
  // waiting for Supabase's CDN, bypassing React Native's aggressive image cache.
  const [localPhotoUri, setLocalPhotoUri] = useState<string | null>(null);

  const [displayNameInput, setDisplayNameInput] = useState("");

  if (userLoading) return null;

  // Derive display values from the Supabase user object.
  // full_name is set by OAuth providers (Google) and by manual edits below.
  const fullName = (user?.user_metadata?.full_name as string | undefined) ?? "";
  const email = user?.email ?? "";
  // custom_avatar_url is set when the user uploads a photo — it is never overwritten
  // by Google OAuth re-logins (which only touch avatar_url). Prefer it over avatar_url
  // so a user-uploaded photo survives logout/re-login cycles.
  const avatarUrl =
    (user?.user_metadata?.custom_avatar_url as string | undefined) ??
    (user?.user_metadata?.avatar_url as string | undefined) ??
    undefined;

  const displayName =
    fullName ||
    email.split("@")[0] ||
    "Unknown User";

  const initials = displayName
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // --- Handlers ---

  // uploadAvatarBuffer: shared upload logic used by both the native and web image picker paths.
  const uploadAvatarBuffer = async (arrayBuffer: ArrayBuffer, mimeType: string) => {
    const fileName = `${user!.id}/avatar.jpg`;
    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(fileName, arrayBuffer, { upsert: true, contentType: mimeType });
    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage
      .from("avatars")
      .getPublicUrl(fileName);

    // Append a cache-busting timestamp so the CDN and React Native's image cache
    // treat each upload as a new resource.
    const cacheBustedUrl = `${publicUrl}?t=${Date.now()}`;

    // Save to custom_avatar_url, not avatar_url. Google OAuth re-logins overwrite
    // avatar_url with the Google profile picture on every sign-in; custom_avatar_url
    // is user-writable only and is never touched by the OAuth flow.
    const { error: updateError } = await supabase.auth.updateUser({
      data: { custom_avatar_url: cacheBustedUrl },
    });
    if (updateError) throw updateError;
  };

  const handlePickImage = async () => {
    if (Platform.OS === "web") {
      // Web: trigger a hidden <input type="file"> — no permission prompt needed in browsers.
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        setUploadingPhoto(true);
        try {
          const arrayBuffer = await file.arrayBuffer();
          await uploadAvatarBuffer(arrayBuffer, file.type || "image/jpeg");
          getTelemetryClient().info("profile.avatar.uploaded", "Profile image uploaded successfully");
        } catch (err) {
          getTelemetryClient().warn("profile.avatar.upload_failed", "Profile image upload failed", {
            message: (err as Error)?.message,
          });
          Alert.alert("Upload failed", (err as Error)?.message ?? "Could not upload photo.");
        } finally {
          setUploadingPhoto(false);
        }
      };
      input.click();
      return;
    }

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission required",
        "Please allow photo access in Settings to upload a profile picture.",
        [{ text: "OK" }]
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });

    if (result.canceled) return;

    const asset = result.assets[0];
    setLocalPhotoUri(asset.uri);
    setUploadingPhoto(true);

    try {
      const mimeType = asset.mimeType ?? "image/jpeg";

      // Read the file as an ArrayBuffer rather than a Blob. On Android, React Native's
      // fetch bridge fails to serialize Blob binary data for outbound HTTPS requests
      // ("Network request failed"). ArrayBuffer bypasses the Blob bridge entirely and
      // is handled natively by both platforms.
      const fileResponse = await fetch(asset.uri);
      const arrayBuffer = await fileResponse.arrayBuffer();

      await uploadAvatarBuffer(arrayBuffer, mimeType);
      getTelemetryClient().info("profile.avatar.uploaded", "Profile image uploaded successfully");
    } catch (err) {
      setLocalPhotoUri(null);
      getTelemetryClient().warn("profile.avatar.upload_failed", "Profile image upload failed", {
        message: (err as Error)?.message,
      });
      Alert.alert(
        "Upload failed",
        (err as Error)?.message ?? "Could not upload profile photo. Please try again.",
        [{ text: "OK" }]
      );
    } finally {
      setUploadingPhoto(false);
    }
  };

  const enterEditMode = () => {
    setDisplayNameInput(fullName);
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({
        data: { full_name: displayNameInput.trim() },
      });
      if (error) throw error;
      // Force a session refresh so the updated full_name propagates into the JWT claims.
      // Without this, auth middleware reads the stale token and re-syncs the old name
      // back to the DB on the next API request, making the change appear to not persist.
      await supabase.auth.refreshSession();
      setEditing(false);
    } catch (err) {
      Alert.alert(
        "Something went wrong",
        (err as Error)?.message ?? "Could not save your name. Please try again.",
        [{ text: "OK" }]
      );
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setDisplayNameInput("");
  };

  const handleSignOut = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          setSigningOut(true);
          try {
            await signOut();
            router.replace("/sign-in");
          } catch {
            Alert.alert("Something went wrong", "Could not sign out. Please try again.", [
              { text: "OK" },
            ]);
          } finally {
            setSigningOut(false);
          }
        },
      },
    ]);
  };

  // --- UI ---
  return (
    <KeyboardAvoidingView
      className={`flex-1 ${t.screen}`}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView>
        <View className="px-5 pt-14 pb-10">

          <Text className={`text-2xl font-bold mb-8 ${t.textPrimary}`}>Profile</Text>

          {/* ── Avatar + identity card ────────────────────────────────────────── */}
          <View className={`${t.surface} rounded-2xl p-5 mb-4 border ${t.border}`}>

            <View className="flex-row items-center gap-4 mb-4">

              {/* Avatar with camera overlay — tapping opens the image picker */}
              <TouchableOpacity
                onPress={handlePickImage}
                disabled={uploadingPhoto || saving}
                style={{ position: "relative", flexShrink: 0 }}
              >
                {localPhotoUri || avatarUrl ? (
                  // Wrap in overflow:hidden View to clip the image to the circle on Android
                  // (borderRadius alone doesn't clip on Android).
                  // Priority: localPhotoUri (immediate preview) > stored avatar URL
                  <View
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: 32,
                      overflow: "hidden",
                    }}
                  >
                    <Image
                      source={{ uri: localPhotoUri ?? avatarUrl }}
                      style={{ width: 64, height: 64 }}
                    />
                  </View>
                ) : (
                  <View
                    className={`w-16 h-16 rounded-full ${t.primaryBg} items-center justify-center`}
                  >
                    <Text className="text-white text-xl font-bold">{initials}</Text>
                  </View>
                )}

                {/* Camera badge — small icon anchored to bottom-right of avatar */}
                <View
                  style={{
                    position: "absolute",
                    bottom: 0,
                    right: 0,
                    backgroundColor: "white",
                    borderRadius: 11,
                    width: 22,
                    height: 22,
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 1,
                    borderColor: "#e5e7eb",
                  }}
                >
                  {uploadingPhoto ? (
                    <ActivityIndicator
                      size="small"
                      color={t.colors.tabBarActive}
                      style={{ transform: [{ scale: 0.6 }] }}
                    />
                  ) : (
                    <Ionicons name="camera" size={13} color={t.colors.tabBarActive} />
                  )}
                </View>
              </TouchableOpacity>

              {/* Name, email, and role badge */}
              <View className="flex-1">
                <Text className={`font-semibold text-lg ${t.textPrimary}`} numberOfLines={1}>
                  {displayName}
                </Text>
                <Text className={`text-sm mb-1 ${t.textSecondary}`} numberOfLines={1}>
                  {email}
                </Text>
                <SystemRoleBadge role={meData?.role} />
              </View>

              {/* Edit / Cancel toggle for name editing */}
              {!saving && (
                <TouchableOpacity onPress={editing ? handleCancelEdit : enterEditMode}>
                  <Ionicons
                    name={editing ? "close-outline" : "pencil-outline"}
                    size={22}
                    color={editing ? t.colors.tabBarInactive : "#2563eb"}
                  />
                </TouchableOpacity>
              )}
            </View>

            {/* ── Edit name form ─────────────────────────────────────────────── */}
            {editing && (
              <View className="gap-3">
                <View className={`border-t ${t.divider} mb-1`} />

                <View>
                  <Text className={`text-xs font-semibold uppercase tracking-widest mb-1 ${t.textTertiary}`}>
                    Display Name
                  </Text>
                  <TextInput
                    className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                    placeholder="Your name"
                    placeholderTextColor={t.colors.tabBarInactive}
                    value={displayNameInput}
                    onChangeText={setDisplayNameInput}
                    autoCapitalize="words"
                    editable={!saving}
                    returnKeyType="done"
                  />
                </View>

                <TouchableOpacity
                  className={`rounded-xl py-4 items-center mt-1 ${saving ? t.primaryBgDisabled : t.primaryBg}`}
                  onPress={handleSave}
                  disabled={saving}
                >
                  {saving ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <Text className="text-white font-semibold text-base">Save Changes</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* ── Following ────────────────────────────────────────────────────── */}
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 mt-2 ${t.textTertiary}`}>
            Following
          </Text>

          <View className={`${t.surface} rounded-2xl mb-4 border ${t.border} overflow-hidden`}>
            {followingLoading ? (
              <View className="py-6 items-center">
                <ActivityIndicator color={t.colors.tabBarActive} />
              </View>
            ) : !following || following.length === 0 ? (
              <View className="py-5 px-4 items-center">
                <Text className={`text-sm ${t.textTertiary}`}>
                  You&apos;re not following anyone yet.
                </Text>
              </View>
            ) : (
              following.map((player, idx) => (
                <TouchableOpacity
                  key={player.id}
                  className={`flex-row items-center gap-3 px-4 py-3 ${
                    idx < following.length - 1 ? `border-b ${t.divider}` : ""
                  }`}
                  onPress={() => router.push(`/users/${player.id}`)}
                  activeOpacity={0.7}
                >
                  <UserAvatar
                    avatarUrl={player.avatar_url}
                    displayName={player.display_name}
                    size={38}
                  />
                  <View className="flex-1">
                    <Text className={`font-semibold text-sm ${t.textPrimary}`} numberOfLines={1}>
                      {player.display_name}
                    </Text>
                    <Text className={`text-xs ${t.textTertiary}`}>
                      {player.rounds_played} {player.rounds_played === 1 ? "round" : "rounds"} played
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={14} color={t.colors.tabBarInactive} />
                </TouchableOpacity>
              ))
            )}
          </View>

          {/* ── Find Players ─────────────────────────────────────────────────── */}
          <TouchableOpacity
            className={`flex-row items-center justify-between ${t.surface} rounded-2xl p-4 mb-4 border ${t.border}`}
            onPress={() => router.push("/users/search")}
            activeOpacity={0.7}
          >
            <View className="flex-row items-center gap-3">
              <Ionicons name="people-outline" size={20} color={t.colors.tabBarActive} />
              <Text className={`font-semibold ${t.textPrimary}`}>Find Players</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={t.colors.tabBarInactive} />
          </TouchableOpacity>

          {/* ── Theme picker ──────────────────────────────────────────────────── */}
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 mt-2 ${t.textTertiary}`}>
            Theme
          </Text>

          <View className="flex-row gap-2 mb-6">
            {THEME_META.map((meta) => {
              const isSelected = themeName === meta.name;
              return (
                <TouchableOpacity
                  key={meta.name}
                  className={`flex-1 rounded-xl py-3 px-2 items-center gap-1.5 ${
                    isSelected
                      ? `border-2 ${t.borderInput} ${t.surfaceSunken}`
                      : `border ${t.border} ${t.surface}`
                  }`}
                  onPress={() => setTheme(meta.name)}
                >
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      backgroundColor: meta.swatch,
                    }}
                  />
                  <Text
                    className={`text-xs ${isSelected ? `font-semibold ${t.textPrimary}` : t.textSecondary}`}
                    numberOfLines={1}
                  >
                    {meta.label}
                  </Text>
                  {isSelected && (
                    <Ionicons name="checkmark-circle" size={14} color={t.colors.tabBarActive} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          {/* ── Score Position picker ─────────────────────────────────────────── */}
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 mt-2 ${t.textTertiary}`}>
            Score Position
          </Text>

          <View className={`${t.surface} rounded-2xl mb-6 border ${t.border} overflow-hidden`}>
            <View className="flex-row items-center justify-between px-4 py-3">
              <Text className={`text-sm ${t.textPrimary}`}>Score entry appears</Text>
              <View className="flex-row gap-2">
                {(["first", "last"] as const).map((pos) => {
                  const active = settings.score_position === pos;
                  const label = pos === "first" ? "Before Stats" : "After Stats";
                  return (
                    <TouchableOpacity
                      key={pos}
                      testID={`score-position-${pos}`}
                      onPress={() => settingsMutation.mutate({ ...settings, score_position: pos })}
                      disabled={settingsMutation.isPending}
                      className={`px-3 py-1.5 rounded-full border ${
                        active ? "bg-green-700 border-green-700" : `${t.surface} ${t.border}`
                      }`}
                      activeOpacity={0.7}
                    >
                      <Text className={`text-xs font-semibold ${active ? "text-white" : t.textSecondary}`}>
                        {label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </View>

          {/* ── Group Visibility toggle ───────────────────────────────────────── */}
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 mt-2 ${t.textTertiary}`}>
            Group Visibility
          </Text>

          <View className={`${t.surface} rounded-2xl mb-6 border ${t.border} overflow-hidden`}>
            <View className="flex-row items-center justify-between px-4 py-3">
              <View className="flex-1 mr-4">
                <Text className={`text-sm ${t.textPrimary}`}>Show group on scorecard</Text>
                <Text className={`text-xs mt-0.5 ${t.textTertiary}`}>
                  {settings.show_group_on_scorecard
                    ? "All players in your group are visible"
                    : "Only your own scores are shown"}
                </Text>
              </View>
              <Switch
                testID="show-group-toggle"
                value={settings.show_group_on_scorecard}
                onValueChange={(val) =>
                  settingsMutation.mutate({ ...settings, show_group_on_scorecard: val })
                }
                trackColor={{ false: "#d1d5db", true: t.colors.tabBarActive }}
                thumbColor="#ffffff"
                disabled={settingsMutation.isPending}
              />
            </View>
          </View>

          {/* ── Scorecard Stats toggles (ordered, draggable via arrows) ─────────── */}
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-3 mt-2 ${t.textTertiary}`}>
            Scorecard Stats
          </Text>

          <View className={`${t.surface} rounded-2xl mb-6 border ${t.border} overflow-hidden`}>
            {settings.stat_order.map((key, idx, arr) => {
              const enabledKey = `${key}_enabled` as keyof ScorecardSettings;
              const label = STAT_META[key] ?? key;
              return (
                <View
                  key={key}
                  className={`flex-row items-center px-4 py-3 ${
                    idx < arr.length - 1 ? `border-b ${t.divider}` : ""
                  }`}
                >
                  {/* Reorder arrows */}
                  <View className="flex-col mr-2">
                    <TouchableOpacity
                      testID={`${key}-up`}
                      onPress={() =>
                        settingsMutation.mutate({ ...settings, stat_order: moveStatUp(settings.stat_order, key) })
                      }
                      disabled={idx === 0 || settingsMutation.isPending}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name="chevron-up"
                        size={18}
                        color={idx === 0 ? t.colors.tabBarInactive : t.colors.tabBarActive}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`${key}-down`}
                      onPress={() =>
                        settingsMutation.mutate({ ...settings, stat_order: moveStatDown(settings.stat_order, key) })
                      }
                      disabled={idx === arr.length - 1 || settingsMutation.isPending}
                      activeOpacity={0.7}
                    >
                      <Ionicons
                        name="chevron-down"
                        size={18}
                        color={idx === arr.length - 1 ? t.colors.tabBarInactive : t.colors.tabBarActive}
                      />
                    </TouchableOpacity>
                  </View>
                  <Text className={`flex-1 text-sm ${t.textPrimary}`}>{label}</Text>
                  <Switch
                    value={settings[enabledKey] as boolean}
                    onValueChange={(val) =>
                      settingsMutation.mutate({ ...settings, [enabledKey]: val })
                    }
                    trackColor={{ false: "#d1d5db", true: t.colors.tabBarActive }}
                    thumbColor="#ffffff"
                    disabled={settingsMutation.isPending}
                  />
                </View>
              );
            })}
          </View>

          {/* ── Sign out button — always red, destructive action ──────────────── */}
          <TouchableOpacity
            className="bg-red-50 border border-red-200 rounded-2xl py-4 items-center mt-2"
            onPress={handleSignOut}
            disabled={signingOut || editing}
          >
            {signingOut ? (
              <ActivityIndicator color="#dc2626" />
            ) : (
              <Text className="text-red-600 font-semibold text-base">Sign Out</Text>
            )}
          </TouchableOpacity>

        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
