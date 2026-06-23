// components/UserAvatar.web.tsx
// Web implementation of UserAvatar — Metro resolves this over UserAvatar.tsx on web.
//
// Why a separate web file: react-native-web's <Image> eagerly loads and decodes every
// instance. The events/rounds detail screens render many avatars via .map() inside a
// plain (non-virtualized) ScrollView, and our avatars are served at full resolution
// (~2000px / ~16 MB decoded each). Decoding all of them at once drove Chromium into a
// memory-pressure renderer crash (STATUS_ILLEGAL_INSTRUCTION), worse the more avatars a
// page showed. A native <img loading="lazy" decoding="async"> fixes it: the browser only
// decodes avatars near the viewport and can evict off-screen bitmaps. The initials
// fallback is identical to UserAvatar.tsx so layout and theming match across platforms.
//
// The <img> is built with React.createElement because RN's JSX namespace has no HTML
// intrinsics — the same constraint that makes DateInput.web.tsx use document.createElement.

import React from "react";
import { View, Text } from "react-native";

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
    // Typed as ImgHTMLAttributes so createElement resolves cleanly (RN's JSX namespace
    // has no <img> intrinsic, so we can't write it as JSX — see file header).
    const imgProps: React.ImgHTMLAttributes<HTMLImageElement> = {
      src: avatarUrl,
      width: size,
      height: size,
      // loading="lazy": don't fetch/decode until the avatar nears the viewport.
      // decoding="async": keep decode off the main thread so it can't jank/stall.
      loading: "lazy",
      decoding: "async",
      // Decorative — the user's name is always shown beside the avatar.
      alt: "",
      style: { width: size, height: size, objectFit: "cover", display: "block" },
    };
    // The wrapping View (a div on web) clips the <img> to the circle via overflow:hidden.
    return (
      <View style={{ width: size, height: size, borderRadius: radius, overflow: "hidden", flexShrink: 0 }}>
        {React.createElement("img", imgProps)}
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
