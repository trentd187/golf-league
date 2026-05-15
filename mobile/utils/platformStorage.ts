// utils/platformStorage.ts
// Platform-agnostic key-value storage used by Zustand's persist middleware.
// On native (iOS/Android): expo-secure-store (encrypted, survives reinstall on iOS).
// On web: localStorage (plaintext — theme preference is not sensitive data).
//
// The interface matches expo-secure-store's async API so the caller is identical
// on both platforms.

import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const webAdapter = {
  getItemAsync: (key: string): Promise<string | null> =>
    Promise.resolve(localStorage.getItem(key)),

  setItemAsync: (key: string, value: string): Promise<void> => {
    localStorage.setItem(key, value);
    return Promise.resolve();
  },

  deleteItemAsync: (key: string): Promise<void> => {
    localStorage.removeItem(key);
    return Promise.resolve();
  },
};

export const platformStorage = Platform.OS === "web" ? webAdapter : SecureStore;
