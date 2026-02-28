// utils/cache.ts
// Provides a token cache implementation for Clerk authentication using Expo SecureStore.
// Clerk needs to persist auth tokens between app sessions. SecureStore encrypts them
// on the device — much safer than AsyncStorage which stores data in plain text.

import * as SecureStore from "expo-secure-store";

export const tokenCache = {
  // Retrieves a stored token by key. Returns null if not found or on error.
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      // If reading fails, delete the corrupted entry and return null
      // so Clerk will treat the user as signed out rather than crashing
      await SecureStore.deleteItemAsync(key);
      return null;
    }
  },

  // Saves a token to secure storage under the given key
  async saveToken(key: string, value: string) {
    try {
      return await SecureStore.setItemAsync(key, value);
    } catch {
      // Silently fail — Clerk will re-fetch tokens if needed
      return;
    }
  },
};
