// app/(tabs)/index.tsx
// The Home screen — the first screen authenticated users see after signing in.
// Shows a personalised greeting using the signed-in user's name from Clerk,
// and placeholder cards for the main sections of the app (events and rounds).
// These cards will be replaced with real data once those features are built.

// useUser provides the currently signed-in Clerk user object (name, email, avatar, etc.)
import { useUser } from "@clerk/clerk-expo";

// React Native core components
// ScrollView: a scrollable container — good practice for home screens as content grows
import { Text, View, ScrollView, TouchableOpacity } from "react-native";

// Ionicons: icon library bundled with Expo (no install needed)
import Ionicons from "@expo/vector-icons/Ionicons";

// useRouter allows navigating to other screens programmatically
import { useRouter } from "expo-router";

// A reusable card component for the home screen sections.
// Props:
//   icon:     Ionicons icon name to show on the left of the card header
//   title:    The card heading (e.g. "Your Leagues")
//   subtitle: A short description shown below the title
//   onPress:  Called when the user taps the card (navigates to the relevant tab)
function HomeCard({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: string;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    // rounded-2xl: rounded corners | shadow-sm: subtle drop shadow | mb-4: spacing below
    <TouchableOpacity
      className="bg-white rounded-2xl p-5 mb-4 border border-gray-100"
      onPress={onPress}
      // activeOpacity: how transparent the card becomes when pressed (0 = fully transparent)
      activeOpacity={0.7}
    >
      {/* Card header row: icon + title + chevron */}
      <View className="flex-row items-center justify-between mb-2">
        <View className="flex-row items-center gap-3">
          {/* Icon shown in green-700 to match the brand colour */}
          <Ionicons name={icon as any} size={22} color="#15803d" />
          <Text className="text-lg font-semibold text-gray-800">{title}</Text>
        </View>
        {/* Chevron arrow indicates the card is tappable */}
        <Ionicons name="chevron-forward-outline" size={20} color="#9ca3af" />
      </View>

      {/* Subtitle / placeholder text */}
      <Text className="text-gray-500 text-sm">{subtitle}</Text>
    </TouchableOpacity>
  );
}

export default function HomeScreen() {
  // user: the full Clerk user object — contains firstName, lastName, emailAddresses, etc.
  // isLoaded: false until Clerk has finished fetching the user from its servers
  const { user, isLoaded } = useUser();

  // router: used to navigate to another tab when a card is tapped
  const router = useRouter();

  // While Clerk is loading, show nothing to avoid a flash of wrong content
  if (!isLoaded) return null;

  // Build a greeting string using the user's first name if available.
  // The "??" operator means "use the right side if the left side is null or undefined"
  const greeting = user?.firstName ? `Welcome back, ${user.firstName}!` : "Welcome back!";

  return (
    // bg-gray-50: a very light gray background that makes the white cards pop
    <ScrollView className="flex-1 bg-gray-50">
      <View className="px-5 pt-14 pb-6">

        {/* Page header */}
        <Text className="text-2xl font-bold text-gray-900 mb-1">{greeting}</Text>
        <Text className="text-gray-500 text-sm mb-8">Here's what's happening in your events.</Text>

        {/* Section heading */}
        <Text className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
          Quick Access
        </Text>

        {/* Events card — tapping navigates to the Events tab */}
        <HomeCard
          icon="trophy-outline"
          title="Your Events"
          subtitle="No active events yet. Join or create one to get started."
          // "/(tabs)/events" matches the events.tsx filename in this directory
          onPress={() => router.push("/(tabs)/events")}
        />

        {/* Rounds card — tapping navigates to the Rounds tab */}
        <HomeCard
          icon="flag-outline"
          title="Recent Rounds"
          subtitle="No rounds played yet. Start a round from an event to enter scores."
          onPress={() => router.push("/(tabs)/rounds")}
        />

      </View>
    </ScrollView>
  );
}
