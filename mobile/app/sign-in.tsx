// app/sign-in.tsx
// Sign-in / sign-up screen — the first screen unauthenticated users see.
//
// Supports two authentication methods:
//   1. Google OAuth    — web-based flow via expo-web-browser
//   2. Email OTP       — passwordless: enter email → 6-digit code → done
//
// The email OTP flow handles both new and returning users automatically —
// Supabase creates the account if the email is new, or signs in if it exists.
//
// Prerequisites (manual setup required before OAuth works):
//   - Supabase: Authentication → URL Configuration → add your redirect URL
//     (e.g. exp://* for Expo Go dev, com.trentd.golfstuffinhere:// for production)
//   - Google Cloud Console: add the same redirect URL to "Authorized redirect URIs"

import { useState } from "react";
import { useRouter } from "expo-router";
import {
  Text,
  View,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as AuthSession from "expo-auth-session";
import { supabase } from "@/utils/supabase";
import { useTheme } from "@/hooks/useTheme";
import { getTelemetryClient } from "@/utils/telemetry";
import { showAlert } from "@/utils/alerts";

// Required for OAuth redirects to complete correctly in Expo — safe to call unconditionally.
WebBrowser.maybeCompleteAuthSession();

export default function SignIn() {
  const router = useRouter();
  const t = useTheme();

  const [email, setEmail]                             = useState("");
  const [code, setCode]                               = useState("");
  const [pendingVerification, setPendingVerification] = useState(false);
  const [loading, setLoading]                         = useState(false);
  const [inlineError, setInlineError]                 = useState("");

  // --- Helpers ---

  const showErrorAlert = (message: string) => {
    showAlert("Something went wrong", message);
  };

  // --- Google OAuth ---
  const handleGoogleOAuth = async () => {
    try {
      setLoading(true);

      if (Platform.OS === "web") {
        // On web, signInWithOAuth redirects the browser tab to Google. The browser then
        // redirects back to /oauth-callback where Supabase (detectSessionInUrl: true)
        // automatically exchanges the code and fires onAuthStateChange(SIGNED_IN).
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: window.location.origin + "/oauth-callback" },
        });
        if (error) {
          getTelemetryClient().warn("auth.google.error", "Google OAuth sign-in failed", {
            message: error.message,
          });
          showErrorAlert(error.message);
        }
        // Browser navigates away — no further code runs in this function.
        return;
      }

      // Native flow — always use the custom scheme so the redirect URL is the same across
      // Expo Go, development builds, and production builds. Without { scheme }, development
      // builds return "exp+golfstuffinhere://expo-development-client" which Supabase
      // doesn't recognise, causing it to fall back to the project's Site URL (localhost:3000).
      //
      // The path "oauth-callback" is intentional: without it, makeRedirectUri returns
      // "golfstuffinhere://" which Expo Router routes to app/index.tsx when Android delivers
      // the deep link. index.tsx runs before the session is set, redirecting to /sign-in.
      // A non-root path hits +not-found.tsx instead (a blank screen for < 1 second) and
      // does not interfere with the navigation stack.
      const redirectTo = AuthSession.makeRedirectUri({ scheme: "golfstuffinhere", path: "oauth-callback" });

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo, skipBrowserRedirect: true },
      });

      if (error || !data.url) {
        getTelemetryClient().warn("auth.google.error", "Google OAuth sign-in failed", {
          message: error?.message,
        });
        showErrorAlert(error?.message ?? "Could not start Google sign-in.");
        return;
      }

      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);

      if (result.type === "success") {
        // Extract just the code from the callback URL. Passing the full custom-scheme URL
        // (golfstuffinhere://...) to exchangeCodeForSession causes GoTrue's server-side
        // URL parser to fail on the non-HTTP scheme, so it can't extract the code and
        // returns "invalid flow state, no valid flow state found".
        const callbackUrl = new URL(result.url);
        const code = callbackUrl.searchParams.get("code");
        if (!code) {
          showErrorAlert("Authorization code missing from callback URL.");
          return;
        }
        const { error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
        if (sessionError) {
          showErrorAlert(sessionError.message);
        } else {
          getTelemetryClient().info("auth.google.success", "Google OAuth sign-in succeeded");
          router.replace("/(tabs)/events");
        }
      }
    } catch (err) {
      showErrorAlert((err as Error)?.message ?? "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  // --- Email OTP: Step 1 — send a 6-digit code ---
  const handleSendEmail = async () => {
    setLoading(true);
    setInlineError("");

    const { error } = await supabase.auth.signInWithOtp({
      email,
      // shouldCreateUser: true is the default — creates an account if the email is new.
      options: { shouldCreateUser: true },
    });

    setLoading(false);

    if (error) {
      showErrorAlert(error.message);
    } else {
      getTelemetryClient().info("auth.otp.sent", "OTP email sent");
      setPendingVerification(true);
    }
  };

  // --- Email OTP: Step 2 — verify the code ---
  const handleVerifyCode = async () => {
    setLoading(true);
    setInlineError("");

    const { error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });

    setLoading(false);

    if (error) {
      // Wrong code — show inline so the user can retry without dismissing a dialog.
      getTelemetryClient().warn("auth.otp.error", "OTP verification failed", {
        message: error.message,
      });
      setInlineError(error.message);
    } else {
      getTelemetryClient().info("auth.otp.verified", "OTP verification succeeded");
      router.replace("/(tabs)/events");
    }
  };

  // --- UI ---
  return (
    // NativeWind's className works reliably on View but not on KeyboardAvoidingView
    // (its types don't declare className), so we wrap.
    <View className={`flex-1 ${t.surface}`}>
      <KeyboardAvoidingView
        // eslint-disable-next-line react-native/no-inline-styles
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {/* keyboardShouldPersistTaps="handled": lets button presses register while the
            keyboard is open without requiring a tap to dismiss it first. */}
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="items-center gap-3 w-full">

            {/* App title — always green-700 (fixed brand color, not themed) */}
            <Text className="text-3xl font-bold text-green-700 mb-1">Golf Stuff In Here</Text>
            <Text className={`text-sm mb-3 ${t.textSecondary}`}>Sign in or create an account to continue</Text>

            {/* OAuth buttons — hidden during OTP code entry */}
            {!pendingVerification && (
              <>
                <TouchableOpacity
                  className="w-full bg-blue-600 rounded-xl py-4 items-center justify-center"
                  onPress={handleGoogleOAuth}
                  disabled={loading}
                >
                  {loading ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <Text className="text-white font-semibold text-base">Continue with Google</Text>
                  )}
                </TouchableOpacity>

                <View className="w-full flex-row items-center gap-3 my-1">
                  <View className={`flex-1 border-t ${t.divider}`} />
                  <Text className={`text-sm ${t.textTertiary}`}>or</Text>
                  <View className={`flex-1 border-t ${t.divider}`} />
                </View>
              </>
            )}

            {/* Email OTP flow */}
            {!pendingVerification ? (
              // Step 1: collect email
              <>
                <TextInput
                  className={`w-full border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.textPrimary}`}
                  placeholder="Email address"
                  placeholderTextColor={t.colors.tabBarInactive}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  value={email}
                  onChangeText={setEmail}
                  editable={!loading}
                />
                <TouchableOpacity
                  className={`w-full rounded-xl py-4 items-center ${loading ? t.primaryBgDisabled : t.primaryBg}`}
                  onPress={handleSendEmail}
                  disabled={loading}
                >
                  {loading ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <Text className="text-white font-semibold text-base">Continue with Email</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              // Step 2: enter the OTP code
              <>
                <Text className={`text-sm text-center ${t.textSecondary}`}>
                  We sent a code to <Text className="font-semibold">{email}</Text>
                </Text>

                <TextInput
                  className={`w-full border rounded-xl px-4 py-3 text-base tracking-widest text-center ${t.borderInput} ${t.textPrimary}`}
                  placeholder="000000"
                  placeholderTextColor={t.colors.tabBarInactive}
                  keyboardType="number-pad"
                  maxLength={6}
                  value={code}
                  onChangeText={setCode}
                  editable={!loading}
                />

                <TouchableOpacity
                  className={`w-full rounded-xl py-4 items-center ${loading ? t.primaryBgDisabled : t.primaryBg}`}
                  onPress={handleVerifyCode}
                  disabled={loading}
                >
                  {loading ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <Text className="text-white font-semibold text-base">Verify Code</Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => {
                    setPendingVerification(false);
                    setCode("");
                    setInlineError("");
                  }}
                  disabled={loading}
                >
                  <Text className={`text-sm underline ${t.textSecondary}`}>Use a different email</Text>
                </TouchableOpacity>
              </>
            )}

            {/* Inline error — for form-level issues like a wrong OTP code */}
            {inlineError ? (
              <Text className="text-red-600 text-sm text-center">{inlineError}</Text>
            ) : null}

            {/* Legal notice — shown on the initial sign-in step only */}
            {!pendingVerification && (
              <Text className={`text-xs text-center mt-2 ${t.textTertiary}`}>
                By continuing, you agree to our{" "}
                <Text
                  className="underline text-green-700"
                  onPress={() => router.push("/terms")}
                  accessibilityLabel="Terms of Service"
                >
                  Terms of Service
                </Text>
                {" "}and{" "}
                <Text
                  className="underline text-green-700"
                  onPress={() => router.push("/privacy")}
                  accessibilityLabel="Privacy Policy"
                >
                  Privacy Policy
                </Text>
              </Text>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
