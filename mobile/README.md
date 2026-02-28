# Golf Stuff In Here — Mobile App

The React Native + Expo mobile app for the Golf Stuff In Here platform.

## Tech Stack

| Tool | Purpose |
|---|---|
| [React Native](https://reactnative.dev) | Cross-platform mobile framework |
| [Expo SDK 55](https://expo.dev) | Toolchain, native modules, and build service |
| [Expo Router](https://expo.github.io/router) | File-based navigation (like Next.js, but for mobile) |
| [TypeScript](https://www.typescriptlang.org) | Type-safe JavaScript |
| [NativeWind v4](https://www.nativewind.dev) | Tailwind CSS utility classes for React Native |
| [Clerk](https://clerk.com) | Authentication (Google OAuth + Email OTP) |
| [TanStack Query](https://tanstack.com/query) | API data fetching, caching, and synchronization |
| [Zustand](https://zustand-demo.pmnd.rs) | Lightweight client-side state management |
| [Expo SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/) | Local offline database for score entry without signal |
| [pnpm](https://pnpm.io) | Package manager (faster and more efficient than npm) |

## Directory Structure

```
mobile/
├── app/                          # Expo Router file-based routes — each file = one screen
│   ├── _layout.tsx               # Root layout: Clerk + React Query providers wrap the whole app
│   ├── index.tsx                 # Auth gate: redirects signed-in users to tabs, others to sign-in
│   ├── sign-in.tsx               # Sign-in screen: Google OAuth and email OTP
│   └── (tabs)/                   # Route group: the main tab navigator after sign-in
│       ├── _layout.tsx           # Tab bar configuration
│       └── index.tsx             # Home screen (leagues and events will go here)
├── components/                   # Reusable UI components shared across screens
├── constants/
│   └── api.ts                    # API_URL — base URL for all backend requests
├── hooks/                        # Custom React hooks
├── stores/                       # Zustand state stores (client-side state)
├── types/                        # Shared TypeScript type definitions
├── utils/
│   └── cache.ts                  # Clerk token cache using Expo SecureStore
├── app.json                      # Expo app configuration (name, scheme, icons, plugins)
├── babel.config.js               # Babel compiler config — enables NativeWind className support
├── metro.config.js               # Metro bundler config — wraps with NativeWind
├── tailwind.config.js            # Tailwind v3 configuration (content paths, NativeWind preset)
├── global.css                    # Tailwind base directives — imported once in app/_layout.tsx
├── nativewind-env.d.ts           # TypeScript declaration that adds className prop to RN components
├── tsconfig.json                 # TypeScript compiler options
├── .env.example                  # Environment variable template — copy to .env and fill in
└── package.json                  # Dependencies and scripts (managed with pnpm)
```

## Setup

### Prerequisites

- Node.js 20 or newer
- pnpm (`npm install -g pnpm`)
- [Expo Go](https://expo.dev/go) app on your physical device, or Android/iOS emulator
- A [Clerk](https://clerk.com) account with Google OAuth enabled

### Environment Variables

Copy the example file and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description | Where to find it |
|---|---|---|
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (safe to expose) | Clerk Dashboard → API Keys |
| `EXPO_PUBLIC_API_URL` | Backend API base URL | `http://localhost:8080` for local dev |

> **Note:** Variables prefixed with `EXPO_PUBLIC_` are embedded in the app bundle and visible to users. Never put secrets, private keys, or passwords in them.

### Install Dependencies

```bash
pnpm install
```

Always use `pnpm` — never `npm install` in this directory. Using npm will create a `package-lock.json` that conflicts with pnpm's `pnpm-lock.yaml`.

### Start the Development Server

```bash
pnpm start
```

Then:
- Press `a` to open on Android emulator
- Press `i` to open on iOS simulator (macOS only)
- Scan the QR code with the Expo Go app on a physical device

## Navigation Structure

This app uses **Expo Router** — screens are defined by files in the `app/` directory:

```
app/
├── index.tsx          →  /          (auth gate — immediately redirects, never visible)
├── sign-in.tsx        →  /sign-in   (shown to unauthenticated users)
└── (tabs)/
    └── index.tsx      →  /          (home screen for authenticated users)
```

The `(tabs)` folder uses parentheses (Expo Router route group syntax) so that `(tabs)` is not included in the URL path.

New screens are added simply by creating new `.tsx` files in `app/`. See the [Expo Router docs](https://expo.github.io/router/docs) for details.

## Styling

Styling is done with **NativeWind** — Tailwind CSS utility classes on React Native components:

```tsx
// Instead of React Native StyleSheet:
<View style={{ flex: 1, alignItems: 'center', backgroundColor: 'white' }}>

// Use NativeWind className:
<View className="flex-1 items-center bg-white">
```

The active color scheme uses `green-700` (`#15803d`) as the primary brand color.

Tailwind v3 is used (not v4) — NativeWind v4 requires Tailwind v3.

## Authentication

Auth is handled by **Clerk**. The flow works as follows:

1. App loads → `app/index.tsx` checks `useAuth().isSignedIn`
2. Not signed in → redirect to `app/sign-in.tsx`
3. User signs in (Google or OTP) → Clerk creates a session
4. Session token stored in device secure storage via `utils/cache.ts`
5. On next launch, Clerk restores the session automatically → user goes straight to tabs

To add auth to a new screen, use Clerk's hooks:
```tsx
import { useAuth, useUser } from "@clerk/clerk-expo";

const { isSignedIn, signOut } = useAuth();
const { user } = useUser();
```

## Making API Calls

Use the `API_URL` constant from `constants/api.ts` and TanStack Query for data fetching:

```tsx
import { useQuery } from "@tanstack/react-query";
import { API_URL } from "@/constants/api";

const { data, isLoading } = useQuery({
  queryKey: ["leagues"],
  queryFn: async () => {
    const res = await fetch(`${API_URL}/api/v1/leagues`);
    return res.json();
  },
});
```

TanStack Query handles caching, background refetching, and loading/error states automatically.

## Building for Production

Builds are managed through **Expo Application Services (EAS)**:

```bash
# Install EAS CLI
pnpm install -g eas-cli

# Log in to Expo
eas login

# Build for Android
eas build --platform android

# Build for iOS (requires Apple Developer account)
eas build --platform ios
```

See the [EAS Build docs](https://docs.expo.dev/build/introduction/) for setup details.
