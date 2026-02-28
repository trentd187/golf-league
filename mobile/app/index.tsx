// app/index.tsx
// This is the root index screen — it's the first screen Expo Router renders when the app loads.
// Its only job is to redirect the user to the correct part of the app based on their auth state.
// It renders no visible UI: it immediately redirects and is never seen by the user.
//
// This pattern (a "gate" or "index redirect") keeps route protection centralized:
// instead of checking auth in every screen, we send all unauthenticated users here first.

// useAuth provides the current Clerk authentication state: isSignedIn, isLoaded, userId, etc.
import { useAuth } from "@clerk/clerk-expo";

// Redirect is an Expo Router component that immediately navigates to a new route.
// It works like a <Navigate /> in React Router or a server-side 302 redirect.
import { Redirect } from "expo-router";

export default function Index() {
  // isSignedIn: true if the user has an active Clerk session, false if not.
  // isLoaded: false until Clerk has finished checking for a stored token.
  //           Always wait for isLoaded before making routing decisions — otherwise
  //           you might redirect away from the app before Clerk has restored the session.
  const { isSignedIn, isLoaded } = useAuth();

  // While Clerk is still initializing (checking SecureStore for a saved token),
  // return null to render nothing. This avoids a "flash" where the sign-in screen
  // briefly appears before Clerk realizes the user is already signed in.
  if (!isLoaded) return null;

  // Once loaded, send the user to the right place:
  // - Signed in → the main tab navigator at "/(tabs)"
  // - Not signed in → the sign-in screen at "/sign-in"
  // The parentheses in "/(tabs)" are an Expo Router convention for "route groups" —
  // a folder named with parentheses groups screens without adding to the URL path.
  return isSignedIn ? (
    <Redirect href="/(tabs)" />
  ) : (
    <Redirect href="/sign-in" />
  );
}
