// app/_layout.tsx
// This is the Root Layout — the top-level wrapper that wraps every screen in the app.
// In Expo Router, a _layout.tsx file in a directory defines the shared layout for all
// routes within that directory. The root _layout.tsx applies to the entire app.
//
// This file sets up three essential providers:
//   1. ClerkProvider   — authentication state (is the user signed in? who are they?)
//   2. QueryClientProvider — server state management (caching API responses)
//   3. Slot            — a placeholder that renders whichever screen is currently active

// Import global Tailwind/NativeWind styles — must be done exactly once at the app root.
// This triggers NativeWind to inject the compiled Tailwind utility styles into the app.
import "../global.css";

// ClerkProvider is the authentication context wrapper. All Clerk hooks (useAuth, useUser, etc.)
// must be used inside ClerkProvider — it makes auth state available throughout the component tree.
// ClerkLoaded delays rendering children until Clerk has finished initializing, preventing
// a flash of unauthenticated UI while Clerk checks for a stored session.
import { ClerkProvider, ClerkLoaded } from "@clerk/clerk-expo";

// React Query is a library for managing server state: fetching, caching, synchronizing,
// and updating data from APIs. QueryClient is the cache instance; QueryClientProvider
// makes it available to any component via the useQuery/useMutation hooks.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Slot is Expo Router's outlet component — it renders the currently matched child route.
// Think of it like a placeholder: whichever screen the user is on gets rendered here.
import { Slot } from "expo-router";

// tokenCache persists Clerk's auth tokens securely between app sessions using expo-secure-store.
// Without this, the user would be signed out every time the app restarts.
import { tokenCache } from "@/utils/cache";

// Create a single QueryClient instance outside the component so it persists across renders.
// If it were created inside the component, a new cache would be created on every re-render,
// throwing away all cached data.
const queryClient = new QueryClient();

// RootLayout is the default export — Expo Router automatically renders this as the root.
export default function RootLayout() {
  // Read the Clerk publishable key from environment variables.
  // The "!" at the end is a TypeScript non-null assertion — it tells TypeScript "trust me,
  // this will not be undefined." If it IS undefined at runtime, you'll get a runtime error,
  // so make sure EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is set in your .env file.
  // The publishable key is safe to embed in the app — it's not a secret.
  const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;

  return (
    // ClerkProvider makes authentication state available to all child components.
    // publishableKey identifies your Clerk application.
    // tokenCache tells Clerk how to persist tokens — we use SecureStore (see utils/cache.ts).
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      {/* ClerkLoaded waits until Clerk has loaded auth state before rendering children.
          This prevents showing a signed-in screen momentarily before Clerk discovers
          the user is actually signed out (or vice versa). */}
      <ClerkLoaded>
        {/* QueryClientProvider makes the React Query cache accessible via hooks
            in any component rendered inside it (the entire app). */}
        <QueryClientProvider client={queryClient}>
          {/* Slot renders the current route's screen component.
              This is the core of Expo Router's file-based routing — the router
              replaces Slot with whichever screen matches the current URL. */}
          <Slot />
        </QueryClientProvider>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
