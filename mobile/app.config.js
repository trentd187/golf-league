// Dynamic Expo config — replaces app.json so we can vary the Android package name
// and app display name per build profile. APP_VARIANT is injected via eas.json env blocks.
// See: https://docs.expo.dev/build-reference/variants/
const IS_DEV = process.env.APP_VARIANT === "development";
const IS_PREVIEW = process.env.APP_VARIANT === "preview";

const getPackageName = () => {
  if (IS_DEV) return "com.trentd.golfstuffinhere.dev";
  if (IS_PREVIEW) return "com.trentd.golfstuffinhere.preview";
  return "com.trentd.golfstuffinhere";
};

const getAppName = () => {
  if (IS_DEV) return "Golf Stuff (Dev)";
  if (IS_PREVIEW) return "Golf Stuff (Preview)";
  return "Golf Stuff In Here";
};

/** @type {import('expo/config').ExpoConfig} */
module.exports = {
  expo: {
    name: getAppName(),
    slug: "golf-stuff-in-here",
    owner: "trentd187",
    scheme: "golfstuffinhere",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "light",
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#ffffff",
    },
    ios: {
      supportsTablet: true,
    },
    android: {
      package: getPackageName(),
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
    },
    web: {
      favicon: "./assets/favicon.png",
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-sqlite",
      "expo-web-browser",
      "expo-font",
      "@react-native-community/datetimepicker",
      // Sentry config plugin — applies the native iOS/Android setup and writes a
      // sentry.properties for build-time source-map upload. org/project/authToken
      // are intentionally omitted here so they fall back to the SENTRY_ORG /
      // SENTRY_PROJECT / SENTRY_AUTH_TOKEN environment variables at build time
      // (provided via EAS Secrets) — no Sentry credentials are committed.
      "@sentry/react-native",
    ],
    extra: {
      router: {},
      eas: {
        projectId: "3c7a6021-c836-48de-8b1b-6681f03d76a3",
      },
      // Build identity, read at runtime by utils/sentry.ts (resolveBuildTags) and attached
      // to every Sentry event as build_commit / app_variant tags so a crash can be pinned
      // to the exact build. app.config.js is evaluated on the build machine, where the git
      // SHA is exposed under different names depending on the builder: EAS native builds
      // set EAS_BUILD_GIT_COMMIT_HASH, the Railway web build sets RAILWAY_GIT_COMMIT_SHA,
      // and GitHub CI sets GITHUB_SHA. Null locally (Expo Go / Metro dev), which is fine —
      // the tag is simply omitted.
      commitSha:
        process.env.EAS_BUILD_GIT_COMMIT_HASH ||
        process.env.RAILWAY_GIT_COMMIT_SHA ||
        process.env.GITHUB_SHA ||
        null,
      appVariant: process.env.APP_VARIANT || null,
    },
  },
};
