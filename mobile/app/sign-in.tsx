// app/sign-in.tsx
// The sign-in / sign-up screen — the first screen unauthenticated users see.
//
// Supports four authentication methods:
//   1. Google OAuth    — one-tap sign in with a Google account
//   2. Facebook OAuth  — sign in with a Facebook account
//   3. Apple Sign In   — sign in with an Apple ID (required on iOS when other OAuth is offered)
//   4. Email OTP       — passwordless: enter email → 6-digit code → done
//
// The email flow is "combined" — it handles both new users (sign-up) and
// returning users (sign-in) from the same screen:
//   - If the email already exists in Clerk → sign-in OTP flow
//   - If the email is new                  → sign-up OTP flow (creates account)
//
// Error handling:
//   - Inline red text: form-level issues (wrong code, invalid email format)
//   - Alert dialog:    unexpected/network errors (has an OK dismiss button)

import { useSignIn, useSignUp, useOAuth } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import {
  Text,
  View,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useState } from "react";
import * as WebBrowser from "expo-web-browser";

// Required for OAuth redirects to complete correctly — safe to call unconditionally
WebBrowser.maybeCompleteAuthSession();

// authMode tracks which Clerk API to call when the user submits their OTP code
type AuthMode = "signIn" | "signUp";

export default function SignIn() {
  // --- Clerk hooks ---
  const { signIn, setActive: setSignInActive, isLoaded: signInLoaded } = useSignIn();
  const { signUp, setActive: setSignUpActive, isLoaded: signUpLoaded } = useSignUp();

  // One hook per OAuth provider — each returns a startOAuthFlow() function
  const { startOAuthFlow: startGoogleOAuth }   = useOAuth({ strategy: "oauth_google" });
  const { startOAuthFlow: startFacebookOAuth } = useOAuth({ strategy: "oauth_facebook" });
  const { startOAuthFlow: startAppleOAuth }    = useOAuth({ strategy: "oauth_apple" });

  const router = useRouter();

  // --- State ---
  const [email, setEmail]                         = useState("");
  const [code, setCode]                           = useState("");
  const [pendingVerification, setPendingVerification] = useState(false);
  const [authMode, setAuthMode]                   = useState<AuthMode>("signIn");
  const [loading, setLoading]                     = useState(false);
  const [inlineError, setInlineError]             = useState("");

  // --- Helpers ---

  // showErrorAlert: native dialog for unexpected errors — user taps OK to dismiss
  const showErrorAlert = (message: string) => {
    Alert.alert("Something went wrong", message, [{ text: "OK" }]);
  };

  // extractClerkMessage: pulls a human-readable string out of a Clerk error object.
  // Clerk errors have an "errors" array with longMessage/message on each item.
  const extractClerkMessage = (err: unknown): string => {
    const clerkErr = err as { errors?: { longMessage?: string; message?: string }[] };
    return (
      clerkErr.errors?.[0]?.longMessage ??
      clerkErr.errors?.[0]?.message ??
      "An unexpected error occurred."
    );
  };

  // --- Generic OAuth handler ---
  // handleOAuth accepts any OAuth flow-starter function, making it reusable for
  // Google, Facebook, and Apple without duplicating the try/catch logic.
  const handleOAuth = async (
    startFlow: () => Promise<{ createdSessionId?: string | null; setActive?: ((opts: { session: string }) => Promise<void>) | null }>
  ) => {
    try {
      setLoading(true);
      const { createdSessionId, setActive: setActiveSession } = await startFlow();
      if (createdSessionId && setActiveSession) {
        await setActiveSession({ session: createdSessionId });
        router.replace("/(tabs)");
      }
    } catch (err) {
      showErrorAlert(extractClerkMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // --- Email OTP: Step 1 — send a code ---
  const handleSendEmail = async () => {
    if (!signInLoaded || !signUpLoaded) return;
    setLoading(true);
    setInlineError("");

    try {
      // Attempt sign-in first (assumes the email already has a Clerk account)
      await signIn!.create({ identifier: email, strategy: "email_code" });
      setAuthMode("signIn");
      setPendingVerification(true);
    } catch (signInErr) {
      // Check if Clerk says the email doesn't exist yet
      const clerkErr = signInErr as { errors?: { code?: string }[] };
      const errCode = clerkErr.errors?.[0]?.code ?? "";
      const isNewUser =
        errCode === "form_identifier_not_found" ||
        errCode === "form_password_incorrect";

      if (isNewUser) {
        // New user — switch to sign-up flow
        try {
          await signUp!.create({ emailAddress: email });
          await signUp!.prepareEmailAddressVerification({ strategy: "email_code" });
          setAuthMode("signUp");
          setPendingVerification(true);
        } catch (signUpErr) {
          setInlineError(extractClerkMessage(signUpErr));
        }
      } else {
        showErrorAlert(extractClerkMessage(signInErr));
      }
    } finally {
      setLoading(false);
    }
  };

  // --- Email OTP: Step 2 — verify the code ---
  const handleVerifyCode = async () => {
    if (!signInLoaded || !signUpLoaded) return;
    setLoading(true);
    setInlineError("");

    try {
      if (authMode === "signIn") {
        const result = await signIn!.attemptFirstFactor({ strategy: "email_code", code });
        if (result.status === "complete") {
          await setSignInActive!({ session: result.createdSessionId });
          router.replace("/(tabs)");
        }
      } else {
        const result = await signUp!.attemptEmailAddressVerification({ code });
        if (result.status === "complete") {
          await setSignUpActive!({ session: result.createdSessionId });
          router.replace("/(tabs)");
        }
      }
    } catch (err) {
      // Wrong code — show as inline error so the user can try again without dismissing a dialog
      setInlineError(extractClerkMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // --- UI ---
  return (
    <View className="flex-1 items-center justify-center bg-white px-6 gap-3">

      {/* Branding */}
      <Text className="text-3xl font-bold text-green-700 mb-1">Golf Stuff In Here</Text>
      <Text className="text-gray-500 text-sm mb-3">Sign in or create an account to continue</Text>

      {/* OAuth buttons — hidden during OTP code entry so the screen stays uncluttered */}
      {!pendingVerification && (
        <>
          {/* Google */}
          <TouchableOpacity
            className="w-full bg-blue-600 rounded-xl py-4 items-center justify-center"
            onPress={() => handleOAuth(startGoogleOAuth)}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-white font-semibold text-base">Continue with Google</Text>
            )}
          </TouchableOpacity>

          {/* Facebook — uses Facebook brand blue (#1877F2) */}
          <TouchableOpacity
            className="w-full rounded-xl py-4 items-center justify-center"
            style={{ backgroundColor: "#1877F2" }}
            onPress={() => handleOAuth(startFacebookOAuth)}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-white font-semibold text-base">Continue with Facebook</Text>
            )}
          </TouchableOpacity>

          {/* Apple — black background per Apple's Human Interface Guidelines.
              Note: Apple requires this button if any other OAuth is offered on iOS. */}
          <TouchableOpacity
            className="w-full bg-black rounded-xl py-4 items-center justify-center"
            onPress={() => handleOAuth(startAppleOAuth)}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-white font-semibold text-base">Continue with Apple</Text>
            )}
          </TouchableOpacity>

          {/* Divider */}
          <View className="w-full flex-row items-center gap-3 my-1">
            <View className="flex-1 border-t border-gray-200" />
            <Text className="text-gray-400 text-sm">or</Text>
            <View className="flex-1 border-t border-gray-200" />
          </View>
        </>
      )}

      {/* Email OTP flow */}
      {!pendingVerification ? (
        // Step 1: collect email
        <>
          <TextInput
            className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base"
            placeholder="Email address"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            editable={!loading}
          />
          <TouchableOpacity
            className={`w-full rounded-xl py-4 items-center ${loading ? "bg-green-400" : "bg-green-700"}`}
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
          <Text className="text-gray-600 text-sm text-center">
            We sent a code to <Text className="font-semibold">{email}</Text>
          </Text>

          <TextInput
            className="w-full border border-gray-300 rounded-xl px-4 py-3 text-base tracking-widest text-center"
            placeholder="000000"
            keyboardType="number-pad"
            maxLength={6}
            value={code}
            onChangeText={setCode}
            editable={!loading}
          />

          <TouchableOpacity
            className={`w-full rounded-xl py-4 items-center ${loading ? "bg-green-400" : "bg-green-700"}`}
            onPress={handleVerifyCode}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-white font-semibold text-base">Verify Code</Text>
            )}
          </TouchableOpacity>

          {/* Back link to re-enter a different email */}
          <TouchableOpacity
            onPress={() => {
              setPendingVerification(false);
              setCode("");
              setInlineError("");
            }}
            disabled={loading}
          >
            <Text className="text-gray-500 text-sm underline">Use a different email</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Inline error — for form-level issues like a wrong OTP code */}
      {inlineError ? (
        <Text className="text-red-600 text-sm text-center">{inlineError}</Text>
      ) : null}
    </View>
  );
}
