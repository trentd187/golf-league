// app/(tabs)/index.tsx
// Safety-net redirect for any navigation that lands on /(tabs) without a sub-path.
// The primary paths (sign-in, oauth-callback, app/index) navigate directly to
// /(tabs)/events now, so this screen is rarely hit. When it is, useEffect defers
// the navigation by one render cycle — avoiding the rapid mount→Redirect→unmount
// sequence that triggers RetryableMountingLayerException on Android Fabric.

import { useEffect } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";

export default function Index() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/(tabs)/events");
  }, [router]);

  return <View className="flex-1" />;
}
