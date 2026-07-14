// utils/platformStorage.ts
// Platform-agnostic key-value storage used by Zustand's persist middleware.
// On native (iOS/Android): expo-secure-store (encrypted, survives reinstall on iOS).
// On web: localStorage (plaintext — theme preference is not sensitive data).
//
// The interface matches expo-secure-store's async API so the caller is identical
// on both platforms.
//
// Every method is `async` — deliberately, and this is not cosmetic. localStorage's methods
// throw SYNCHRONOUSLY (SecurityError when storage is blocked in a third-party/embedded
// context; QuotaExceededError when it's full). The previous non-async arrows returned
// `Promise.resolve(localStorage.getItem(key))`, so the throw escaped BEFORE a promise ever
// existed — which meant the `.catch()` guards the stores wrap these in (themeStore.ts,
// listPrefsStore.ts) could never see it, and a storage failure crashed the caller instead of
// degrading. Marking them async converts the sync throw into a rejected promise, which is what
// those guards were written to handle all along.

import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const webAdapter = {
  getItemAsync: async (key: string): Promise<string | null> => localStorage.getItem(key),

  setItemAsync: async (key: string, value: string): Promise<void> => {
    localStorage.setItem(key, value);
  },

  deleteItemAsync: async (key: string): Promise<void> => {
    localStorage.removeItem(key);
  },
};

export const platformStorage = Platform.OS === "web" ? webAdapter : SecureStore;
