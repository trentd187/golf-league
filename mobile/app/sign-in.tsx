// app/sign-in.tsx
// The sign-in screen — the first thing unauthenticated users see.
// It supports two authentication methods:
//   1. Google OAuth (one-tap sign in with a Google account)
//   2. Email OTP (passwordless: enter email, receive a one-time code, enter code)
//
// Both methods are handled by Clerk, which manages the full auth flow including
// token issuance, session management, and secure storage.

// useSignIn: hook for email/password and OTP sign-in flows
// useOAuth: hook for starting a third-party OAuth flow (Google, Apple, etc.)
import { useSignIn, useOAuth } from "@clerk/clerk-expo";

// useRouter gives programmatic navigation — we use it to redirect after sign-in
import { useRouter } from "expo-router";

// React Native core UI components
import { Text, View, TouchableOpacity, TextInput } from "react-native";

// useState is React's built-in hook for local component state
import { useState } from "react";

// expo-web-browser opens the OAuth consent screen in a secure in-app browser.
// maybeCompleteAuthSession() must be called at the module level — it handles
// the redirect back from the OAuth provider when the browser session finishes.
import * as WebBrowser from "expo-web-browser";

// This call is required for OAuth to work on Android and some iOS configurations.
// It checks if an auth session is pending completion and resolves it.
// Safe to call unconditionally — it does nothing if there's no pending session.
WebBrowser.maybeCompleteAuthSession();

export default function SignIn() {
  // signIn: Clerk's sign-in object with methods to start/complete a sign-in attempt
  // setActive: activates a Clerk session (marks the user as signed in)
  // isLoaded: false until Clerk has initialized — always guard calls with this
  const { signIn, setActive, isLoaded } = useSignIn();

  // Configure the OAuth flow for Google. "strategy" selects which provider to use.
  // startGoogleOAuth() opens the Google OAuth consent screen and handles the callback.
  const { startOAuthFlow: startGoogleOAuth } = useOAuth({ strategy: "oauth_google" });

  // useRouter lets us navigate programmatically (without the user tapping a link)
  const router = useRouter();

  // Local state for the email OTP flow:
  const [email, setEmail] = useState("");                       // The email address the user types in
  const [code, setCode] = useState("");                         // The 6-digit OTP code Clerk sends
  const [pendingVerification, setPendingVerification] = useState(false); // True after OTP is sent; shows the code input

  // --- Google OAuth handler ---
  const handleGoogleSignIn = async () => {
    try {
      // startGoogleOAuth() opens a WebBrowser session with Google's OAuth page.
      // When the user grants permission, Google redirects back to the app and
      // Clerk creates a session, returning createdSessionId.
      const { createdSessionId, setActive: setActiveSession } = await startGoogleOAuth();

      if (createdSessionId && setActiveSession) {
        // Activate the session so Clerk considers the user signed in
        await setActiveSession({ session: createdSessionId });
        // Navigate to the main tab screen — replace() removes sign-in from the history
        // stack so the user can't navigate "back" to the sign-in screen.
        router.replace("/(tabs)");
      }
    } catch (err) {
      console.error("Google sign-in error:", err);
    }
  };

  // --- Email OTP: Step 1 — request a one-time code ---
  const handleSendOtp = async () => {
    // Always guard Clerk calls with isLoaded to avoid calling before initialization
    if (!isLoaded) return;
    try {
      // signIn.create() starts the sign-in attempt.
      // identifier is the user's email; strategy "email_code" tells Clerk to send
      // a one-time passcode to that email rather than requiring a password.
      await signIn.create({ identifier: email, strategy: "email_code" });

      // Switch the UI to show the code-entry form instead of the email form
      setPendingVerification(true);
    } catch (err) {
      console.error("OTP send error:", err);
    }
  };

  // --- Email OTP: Step 2 — verify the code the user received ---
  const handleVerifyOtp = async () => {
    if (!isLoaded) return;
    try {
      // attemptFirstFactor() submits the code the user entered.
      // If correct, Clerk returns status: "complete" and a new session.
      const result = await signIn.attemptFirstFactor({ strategy: "email_code", code });

      if (result.status === "complete") {
        // Activate the newly created session so the user is signed in
        await setActive({ session: result.createdSessionId });
        router.replace("/(tabs)");
      }
    } catch (err) {
      console.error("OTP verify error:", err);
    }
  };

  // --- UI ---
  // NativeWind utility classes (className="...") provide Tailwind-style styling.
  // "flex-1" means this View takes all available space.
  // "items-center justify-center" centers children horizontally and vertically.
  return (
    <View className="flex-1 items-center justify-center bg-white p-6 gap-4">
      <Text className="text-3xl font-bold text-green-700 mb-4">Golf Stuff In Here</Text>

      {/* Google sign-in button */}
      <TouchableOpacity
        className="w-full bg-blue-600 rounded-xl py-4 items-center"
        onPress={handleGoogleSignIn}
      >
        <Text className="text-white font-semibold text-base">Continue with Google</Text>
      </TouchableOpacity>

      {/* Horizontal divider between OAuth and email OTP sections */}
      <View className="w-full border-t border-gray-200 my-2" />

      {/* Conditional rendering: show email input OR code input based on pendingVerification state */}
      {!pendingVerification ? (
        // Step 1: collect the user's email address
        <>
          <TextInput
            className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base"
            placeholder="Email address"
            autoCapitalize="none"          // Don't auto-capitalize email addresses
            keyboardType="email-address"   // Shows the @ key and optimized email keyboard
            value={email}
            onChangeText={setEmail}        // Update state on every keystroke
          />
          <TouchableOpacity
            className="w-full bg-green-700 rounded-xl py-4 items-center"
            onPress={handleSendOtp}
          >
            <Text className="text-white font-semibold text-base">Send One-Time Code</Text>
          </TouchableOpacity>
        </>
      ) : (
        // Step 2: user has received the OTP — collect the 6-digit code
        <>
          <TextInput
            className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base tracking-widest"
            placeholder="Enter code"
            keyboardType="number-pad"  // Numeric keyboard for the digit code
            value={code}
            onChangeText={setCode}
          />
          <TouchableOpacity
            className="w-full bg-green-700 rounded-xl py-4 items-center"
            onPress={handleVerifyOtp}
          >
            <Text className="text-white font-semibold text-base">Verify Code</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}
