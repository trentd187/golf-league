// components/SaveStatusBanner.tsx
// A non-blocking banner shown on the scorecard when a save has ultimately failed.
//
// Why a banner and not an Alert: a modal Alert mid-round is the "panic error" — it stops
// play, it has to be dismissed before the next hole can be scored, and it makes a transient
// cellular blip feel like data loss. The player is standing on a tee box holding a phone in
// one hand; they cannot be interrupted.
//
// This appears ONLY after savePut has exhausted every retry AND the phantom-save reconcile
// failed to confirm the write — i.e. the edit genuinely is not on the server yet. The edit is
// still held in local state and on screen, and the next edit to the same player/hole retries
// it, so the honest message is "not synced yet", not "lost".
//
// Cross-platform: pure NativeWind + RN primitives, safe on native and web.

import { View, Text, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

export interface SaveStatusBannerProps {
  // message describes what didn't sync, in the player's terms ("Scores", "Stats").
  message: string;
  // onRetry re-runs the failed save. Omit to render an informational banner with no action.
  onRetry?: () => void;
  // retrying disables the button and shows progress, so a double-tap can't queue two saves.
  retrying?: boolean;
}

// SaveStatusBanner renders an inline, dismissable-by-success warning strip. It never covers
// the scorecard and never blocks input — scoring continues underneath it.
export function SaveStatusBanner({ message, onRetry, retrying = false }: Readonly<SaveStatusBannerProps>) {
  const t = useTheme();

  return (
    <View
      className={`flex-row items-center gap-2 px-4 py-2.5 border-t border-b border-amber-500/40 bg-amber-500/10 ${t.divider}`}
      accessibilityRole="alert"
    >
      <Ionicons name="cloud-offline-outline" size={16} color={t.colors.warning} />
      <View className="flex-1">
        <Text className="text-xs font-semibold text-amber-700">{message}</Text>
        {/* The reassurance is the point: the number is on the phone, it just hasn't reached
            the server. Without this line a player assumes the score is gone and re-enters it. */}
        <Text className={`text-xs ${t.textTertiary}`}>
          Saved on this phone — it will sync when you&apos;re back online.
        </Text>
      </View>
      {onRetry && (
        <TouchableOpacity
          onPress={onRetry}
          disabled={retrying}
          activeOpacity={0.7}
          className={`rounded-md px-3 py-1.5 ${retrying ? "bg-amber-500/30" : "bg-amber-600"}`}
          accessibilityRole="button"
          accessibilityLabel="Retry saving"
        >
          <Text className={`text-xs font-semibold ${retrying ? "text-amber-800" : "text-white"}`}>
            {retrying ? "Retrying…" : "Retry"}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default SaveStatusBanner;
