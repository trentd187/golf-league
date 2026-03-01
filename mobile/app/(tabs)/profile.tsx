// app/(tabs)/profile.tsx
// The Profile screen — shows the signed-in user's information and lets them:
//   1. Upload or change their profile photo (stored by Clerk, works for all sign-in methods)
//   2. Edit their first and last name
//   3. Sign out
//
// Profile photo flow:
//   - Tap the avatar → expo-image-picker opens the photo library
//   - User selects a photo → it's converted to a Blob and uploaded via user.setProfileImage()
//   - Clerk stores the image and serves it via user.imageUrl
//   - Google SSO users already have user.imageUrl set from their Google profile

// useUser: Clerk hook — provides the current user object and an isLoaded flag
// useAuth: Clerk hook — provides signOut()
import { useUser, useAuth } from "@clerk/clerk-expo";

import { useRouter } from "expo-router";

// expo-image-picker: lets the user pick a photo from their device's photo library.
// This is an Expo SDK native module, so it works in Expo Go without a custom build.
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
  // Image: the standard React Native component for displaying images from URIs
  Image,
} from "react-native";

import { useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";

// RoleBadge renders a small coloured pill showing the user's permission level.
// - admin   → green  (full access)
// - manager → blue   (league/event management)
// - user    → gray   (regular player)
function RoleBadge({ role }: { role?: string }) {
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

export default function ProfileScreen() {
  const { user, isLoaded } = useUser();
  const { signOut } = useAuth();
  const router = useRouter();

  // --- UI state ---
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // uploadingPhoto: true while we're uploading the selected photo to Clerk
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  // localPhotoUri: the file:// URI of the image the user just picked.
  // We display this immediately so the avatar updates without waiting for Clerk's CDN.
  // React Native's Image component caches aggressively by URI, so showing the local
  // file URI bypasses any stale cache of the old Clerk imageUrl.
  const [localPhotoUri, setLocalPhotoUri] = useState<string | null>(null);

  // Edit form values — seeded from the current Clerk user when editing starts
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  if (!isLoaded) return null;

  // --- Derived display values ---
  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    user?.primaryEmailAddress?.emailAddress?.split("@")[0] ||
    "Unknown User";

  const email = user?.primaryEmailAddress?.emailAddress ?? "";

  // initials: shown in the avatar circle when the user has no profile image
  const initials = displayName
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // --- Handlers ---

  // handlePickImage: opens the device photo library and uploads the selected image to Clerk.
  // Clerk stores the image and makes it available as user.imageUrl (via its CDN).
  // This works for all sign-in methods. Google SSO users already have imageUrl set.
  const handlePickImage = async () => {
    // Step 1: request permission to read the device's media library.
    // On Android this shows a system prompt; on iOS it uses the system picker which
    // handles permissions internally. We still call requestMediaLibraryPermissionsAsync
    // so the flow is consistent across platforms.
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission required",
        "Please allow photo access in Settings to upload a profile picture.",
        [{ text: "OK" }]
      );
      return;
    }

    // Step 2: open the image picker. allowsEditing=true shows a crop UI.
    // aspect: [1, 1] forces a square crop — correct for a circular avatar.
    const result = await ImagePicker.launchImageLibraryAsync({
      // Pass mediaTypes as a string array — the safest form in expo-image-picker v17.
      // ImagePicker.MediaType enum is not reliably exported in v17.0.10 at runtime,
      // and MediaTypeOptions is deprecated. The string array ['images'] works in both.
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8, // 0.8 keeps quality high while reducing file size a bit
    });

    // The user tapped Cancel — nothing to do
    if (result.canceled) return;

    const asset = result.assets[0];

    // Show the picked image instantly — don't wait for the upload or CDN propagation.
    // This gives immediate visual feedback and avoids React Native's image cache
    // serving the old photo even after Clerk updates the URL.
    setLocalPhotoUri(asset.uri);
    setUploadingPhoto(true);
    try {
      // Step 3: Read the image file as raw binary data.
      // We use arrayBuffer() rather than blob() because React Native's Blob
      // implementation doesn't reliably expose file bytes when re-wrapped —
      // new Blob([existingBlob]) can encode the object reference instead of
      // the actual bytes, resulting in a corrupt or empty upload that Clerk
      // silently accepts without throwing. arrayBuffer() gives us the raw bytes
      // directly, which we can then wrap into a properly-typed Blob.
      const response = await fetch(asset.uri);
      const arrayBuffer = await response.arrayBuffer();
      // asset.mimeType is e.g. "image/jpeg" or "image/png" — provided by the picker.
      const mimeType = asset.mimeType ?? "image/jpeg";
      // Build the Blob from raw bytes + explicit MIME type. Clerk requires a
      // non-empty type to process the upload correctly.
      const blob = new Blob([arrayBuffer], { type: mimeType });

      // Step 4: Upload to Clerk. Clerk resizes, optimises, and stores the image.
      await user?.setProfileImage({ file: blob });

      // Step 5: Force Clerk to re-fetch the user object so user.imageUrl reflects
      // the newly uploaded photo. Without this, useUser() may keep serving the
      // stale cached user (Clerk's React Native SDK doesn't always push the update
      // reactively after setProfileImage).
      await user?.reload();
    } catch (err) {
      // If upload failed, clear the local preview so the old avatar is restored
      setLocalPhotoUri(null);
      // Log the full error to the Metro console for debugging
      console.error("[Profile] setProfileImage failed:", err);
      // Surface the actual error message so Clerk errors are visible
      const message =
        (err as any)?.errors?.[0]?.longMessage ??
        (err as any)?.errors?.[0]?.message ??
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
      className="flex-1 bg-gray-50"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView>
        <View className="px-5 pt-14 pb-10">

          <Text className="text-2xl font-bold text-gray-900 mb-8">Profile</Text>

          {/* ── Avatar + identity card ────────────────────────────────────────── */}
          <View className="bg-white rounded-2xl p-5 mb-4 border border-gray-100">

            <View className="flex-row items-center gap-4 mb-4">

              {/* ── Avatar with camera overlay ──────────────────────────────── */}
              {/* Tapping the avatar opens the image picker.                     */}
              {/* Disabled while a photo upload or name save is in progress.     */}
              <TouchableOpacity
                onPress={handlePickImage}
                disabled={uploadingPhoto || saving}
                // We use a View wrapper with relative positioning so the camera
                // badge can be absolutely positioned in the corner of the avatar.
                style={{ position: "relative", flexShrink: 0 }}
              >
                {localPhotoUri || user?.imageUrl ? (
                  // Show the profile image. Priority:
                  //   1. localPhotoUri — set immediately after the user picks a photo,
                  //      so the avatar updates instantly without waiting for CDN propagation
                  //   2. user.imageUrl — the Clerk-hosted URL (Google SSO or previous upload)
                  // We wrap in a View with overflow:hidden to clip the image to the circle
                  // on both iOS and Android (borderRadius alone doesn't clip on Android).
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
                  // Fallback: green circle with the user's initials
                  <View className="w-16 h-16 rounded-full bg-green-700 items-center justify-center">
                    <Text className="text-white text-xl font-bold">{initials}</Text>
                  </View>
                )}

                {/* Camera badge — small icon in the bottom-right corner of the avatar */}
                <View
                  style={{
                    position: "absolute",
                    bottom: 0,
                    right: 0,
                    // White circle background so the icon is readable over any avatar colour
                    backgroundColor: "white",
                    borderRadius: 11,
                    width: 22,
                    height: 22,
                    alignItems: "center",
                    justifyContent: "center",
                    // Light gray border matches the card's border colour
                    borderWidth: 1,
                    borderColor: "#e5e7eb",
                  }}
                >
                  {uploadingPhoto ? (
                    // Show a spinner while the upload is in progress
                    <ActivityIndicator size="small" color="#15803d" style={{ transform: [{ scale: 0.6 }] }} />
                  ) : (
                    <Ionicons name="camera" size={13} color="#15803d" />
                  )}
                </View>
              </TouchableOpacity>

              {/* Name, email, and role badge */}
              <View className="flex-1">
                <Text className="text-gray-900 font-semibold text-lg" numberOfLines={1}>
                  {displayName}
                </Text>
                <Text className="text-gray-500 text-sm mb-1" numberOfLines={1}>
                  {email}
                </Text>
                <RoleBadge role={(user?.publicMetadata as { role?: string })?.role} />
              </View>

              {/* Edit / Cancel toggle for name editing */}
              {!saving && (
                <TouchableOpacity onPress={editing ? handleCancelEdit : enterEditMode}>
                  <Ionicons
                    name={editing ? "close-outline" : "pencil-outline"}
                    size={22}
                    color={editing ? "#6b7280" : "#2563eb"}
                  />
                </TouchableOpacity>
              )}
            </View>

            {/* ── Edit name form ─────────────────────────────────────────────── */}
            {editing && (
              <View className="gap-3">
                <View className="border-t border-gray-100 mb-1" />

                <View>
                  <Text className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1">
                    First Name
                  </Text>
                  <TextInput
                    className="border border-gray-300 rounded-xl px-4 py-3 text-base bg-gray-50"
                    placeholder="First name"
                    value={firstName}
                    onChangeText={setFirstName}
                    autoCapitalize="words"
                    editable={!saving}
                    returnKeyType="next"
                  />
                </View>

                <View>
                  <Text className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1">
                    Last Name
                  </Text>
                  <TextInput
                    className="border border-gray-300 rounded-xl px-4 py-3 text-base bg-gray-50"
                    placeholder="Last name"
                    value={lastName}
                    onChangeText={setLastName}
                    autoCapitalize="words"
                    editable={!saving}
                    returnKeyType="done"
                  />
                </View>

                <TouchableOpacity
                  className={`rounded-xl py-4 items-center mt-1 ${saving ? "bg-green-400" : "bg-green-700"}`}
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

          {/* ── Sign out button ────────────────────────────────────────────────── */}
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
