// components/UserAvatar.tsx
// Circular avatar: shows the user's photo if a URL is available,
// falls back to a green initials circle when no photo has been set.
// Used wherever a user's name appears in a list (members, group players, etc.).

import { Image, View, Text } from "react-native";

type Props = {
  avatarUrl?: string | null;
  displayName: string;
  // Diameter in logical pixels. Defaults to 36 (standard list-row size).
  size?: number;
};

export default function UserAvatar({ avatarUrl, displayName, size = 36 }: Props) {
  const radius = size / 2;
  // Font size scales proportionally with the avatar size.
  const fontSize = Math.round(size * 0.4);

  if (avatarUrl) {
    // overflow: "hidden" is required on Android to clip the image to the circle —
    // borderRadius alone does not clip child content on Android.
    return (
      <View style={{ width: size, height: size, borderRadius: radius, overflow: "hidden", flexShrink: 0 }}>
        <Image source={{ uri: avatarUrl }} style={{ width: size, height: size }} />
      </View>
    );
  }

  return (
    <View
      style={{ width: size, height: size, borderRadius: radius, flexShrink: 0 }}
      className="bg-green-100 items-center justify-center"
    >
      <Text className="text-green-700 font-bold" style={{ fontSize }}>
        {displayName.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}
