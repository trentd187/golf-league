// app/(tabs)/profile.tsx
// The Profile screen — shows the signed-in user's information and lets them:
//   1. Upload or change their profile photo (stored by Clerk, works for all sign-in methods)
//   2. Edit their first and last name
//   3. Switch the app theme (Light, Dark, Colorful, Grey)
//   4. Sign out
//
// Profile photo flow:
//   - Tap the avatar → expo-image-picker opens the photo library
//   - User selects a photo → sent to our backend (PATCH /api/v1/me/profile-image)
//   - Backend forwards the file to Clerk's Backend API using the secret key
//   - Clerk stores the image and serves it via user.imageUrl
//
// Why we proxy through our backend instead of calling Clerk directly:
//   - user.setProfileImage() (Clerk SDK): silently fails in React Native because
//     BlobManager produces untyped Blobs that Clerk's API ignores.
//   - Clerk's Frontend API: uses browser-cookie auth and rejects native clients.
//   - Our backend receives the image with the normal JWT auth we use everywhere else,
//     then calls Clerk's Backend API with the secret key (which only lives server-side).

import { useUser, useAuth } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
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
} from "react-native";
import { useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import { API_URL } from "@/constants/api";
import { useTheme } from "@/hooks/useTheme";
import { useThemeStore } from "@/stores/themeStore";
import { THEME_META } from "@/themes";

// ─── Sub-components ───────────────────────────────────────────────────────────

// SystemRoleBadge renders a small coloured pill showing the user's platform-level role.
// This is distinct from the event-level RoleBadge in components/badges.tsx.
// Role colors are categorical — hardcoded and NOT affected by the theme.
function SystemRoleBadge({ role }: { role?: string }) {
  const styles: Record<string, { bg: string; text: string; label: string }> = {
    admin:   { bg: "bg-green-100",  text: "text-green-700", label: "Admin" },
    manager: { bg: "bg-blue-100",   text: "text-blue-700",  label: "Manager" },
    user:    { bg: "bg-gray-100",   text: "text-gray-600",  label: "User" },
  };
  const style = styles[role ?? ""] ?? styles.user;
  const label = styles[role ?? ""]?.label ?? "User";
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${style.bg}`}>
      <Text className={`text-xs font-semibold ${style.text}`}>{label}</Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ProfileScreen() {
  const { user, isLoaded } = useUser();
  const { signOut, getToken } = useAuth();
  const router = useRouter();
  const t = useTheme();

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
  // waiting for Clerk's CDN, bypassing React Native's aggressive image cache.
  const [localPhotoUri, setLocalPhotoUri] = useState<string | null>(null);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  if (!isLoaded) return null;

  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.primaryEmailAddress?.emailAddress?.split("@")[0] ||
    "Unknown User";

  const email = user?.primaryEmailAddress?.emailAddress ?? "";

  const initials = displayName
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // --- Handlers ---

  const handlePickImage = async () => {
    // Fetch the Clerk token BEFORE opening the image picker. When launchImageLibraryAsync()
    // opens the native photo library, the app goes to the background. On some Expo Go +
    // Clerk SDK versions this resets Clerk's in-memory session state, causing getToken()
    // to throw "You are signed out" if called after the picker closes.
    const token = await getToken();
    if (!token) {
      Alert.alert(
        "Session expired",
        "Your session has expired. Please sign out and sign back in.",
        [{ text: "OK" }]
      );
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
      // String array form — ImagePicker.MediaType enum isn't reliably exported in v17.0.10
      // at runtime, and MediaTypeOptions is deprecated. ['images'] works in both.
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1], // square crop for circular avatar
      quality: 0.8,
    });

    if (result.canceled) return;

    const asset = result.assets[0];

    // Show the picked image instantly before the upload completes.
    setLocalPhotoUri(asset.uri);
    setUploadingPhoto(true);
    try {
      // React Native's native networking layer understands { uri, type, name } in FormData —
      // it reads the file:// URI at the OS level, bypassing BlobManager entirely.
      // This avoids all known RN Blob limitations (untyped blobs, no ArrayBuffer support).
      // "as any" is required because TS's FormData types don't include RN's extended format.
      const mimeType = asset.mimeType ?? "image/jpeg";
      const ext = mimeType.split("/")[1] || "jpg";

      const formData = new FormData();
      formData.append("file", {
        uri: asset.uri,
        type: mimeType,
        name: `profile.${ext}`,
      } as any);

      // Do NOT set Content-Type manually — RN sets "multipart/form-data; boundary=..."
      // automatically when the body is FormData. Setting it manually omits the boundary.
      const res = await fetch(`${API_URL}/api/v1/me/profile-image`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          body.errors?.[0]?.long_message ??
          body.errors?.[0]?.message ??
          body.error ??
          `Upload failed with status ${res.status}`;
        throw new Error(message);
      }

      // Reload the Clerk user so user.imageUrl reflects the new photo.
      // The React Native SDK doesn't always push the update reactively.
      await user?.reload();
    } catch (err) {
      setLocalPhotoUri(null);
      console.error("[Profile] profile image upload failed:", err);
      const message =
        (err as Error)?.message ??
        "Could not upload profile photo. Please try again.";
      Alert.alert("Upload failed", message, [{ text: "OK" }]);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const enterEditMode = () => {
    setFirstName(user?.firstName ?? "");
    setLastName(user?.lastName ?? "");
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await user?.update({ firstName: firstName.trim(), lastName: lastName.trim() });
      setEditing(false);
    } catch (err) {
      const clerkErr = err as { errors?: { longMessage?: string; message?: string }[] };
      const msg =
        clerkErr.errors?.[0]?.longMessage ??
        clerkErr.errors?.[0]?.message ??
        "Could not save your name. Please try again.";
      Alert.alert("Something went wrong", msg, [{ text: "OK" }]);
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setFirstName("");
    setLastName("");
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
      behavior={Platform.OS === "ios" ? "padding" : undefined}
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
                {localPhotoUri || user?.imageUrl ? (
                  // Wrap in overflow:hidden View to clip the image to the circle on Android
                  // (borderRadius alone doesn't clip on Android).
                  // Priority: localPhotoUri (immediate preview) > user.imageUrl (CDN)
                  <View
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: 32,
                      overflow: "hidden",
                    }}
                  >
                    <Image
                      source={{ uri: localPhotoUri ?? user!.imageUrl }}
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
                <SystemRoleBadge role={(user?.publicMetadata as { role?: string })?.role} />
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
                    First Name
                  </Text>
                  <TextInput
                    className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                    placeholder="First name"
                    placeholderTextColor={t.colors.tabBarInactive}
                    value={firstName}
                    onChangeText={setFirstName}
                    autoCapitalize="words"
                    editable={!saving}
                    returnKeyType="next"
                  />
                </View>

                <View>
                  <Text className={`text-xs font-semibold uppercase tracking-widest mb-1 ${t.textTertiary}`}>
                    Last Name
                  </Text>
                  <TextInput
                    className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
                    placeholder="Last name"
                    placeholderTextColor={t.colors.tabBarInactive}
                    value={lastName}
                    onChangeText={setLastName}
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
                  // Selected: thicker border (border-2) + sunken background.
                  // Both border-width and border-color are separate literals so Tailwind JIT scans them.
                  className={`flex-1 rounded-xl py-3 px-2 items-center gap-1.5 ${
                    isSelected
                      ? `border-2 ${t.borderInput} ${t.surfaceSunken}`
                      : `border ${t.border} ${t.surface}`
                  }`}
                  onPress={() => setTheme(meta.name)}
                >
                  {/* Color swatch */}
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
