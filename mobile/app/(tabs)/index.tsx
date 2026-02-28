// app/(tabs)/index.tsx
// The Home screen — the main screen authenticated users land on after signing in.
// Currently a placeholder that will eventually display leagues, events, and scores.
// It also provides a sign-out button for development/testing.

// useAuth provides Clerk authentication utilities — here we use signOut()
import { useAuth } from "@clerk/clerk-expo";

// useRouter provides programmatic navigation (send the user to another screen in code)
import { useRouter } from "expo-router";

// React Native core UI primitives
import { Text, View, TouchableOpacity } from "react-native";

export default function HomeScreen() {
  // signOut() ends the current Clerk session and clears stored tokens.
  // After calling it, useAuth().isSignedIn will become false, and index.tsx
  // (the root redirect screen) will send the user back to /sign-in.
  const { signOut } = useAuth();

  // router lets us navigate programmatically after sign-out
  const router = useRouter();

  const handleSignOut = async () => {
    // Sign the user out of Clerk — this clears the session on both Clerk's servers
    // and the local secure storage token cache.
    await signOut();

    // After signing out, redirect to the sign-in screen.
    // replace() is used instead of push() so the user can't press "back" to return
    // to the home screen without being signed in again.
    router.replace("/sign-in");
  };

  return (
    // "flex-1" makes the View fill the entire screen height.
    // "items-center justify-center" centers all children in the middle of the screen.
    <View className="flex-1 items-center justify-center bg-white gap-4">
      <Text className="text-2xl font-bold text-green-700">Golf Stuff In Here</Text>

      {/* Placeholder text — this will be replaced with real league/event content */}
      <Text className="text-gray-500">Leagues and events will appear here.</Text>

      {/* Sign out button — primarily for development. In a production app this
          might live in a settings screen or a profile menu instead. */}
      <TouchableOpacity
        className="bg-gray-200 rounded-xl px-6 py-3"
        onPress={handleSignOut}
      >
        <Text className="text-gray-700 font-medium">Sign Out</Text>
      </TouchableOpacity>
    </View>
  );
}
