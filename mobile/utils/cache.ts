// utils/cache.ts
// Token cache implementation for Clerk using expo-secure-store.
// Clerk needs to persist auth tokens between sessions. SecureStore encrypts them
// on the device — safer than AsyncStorage which stores data in plain text.

import * as SecureStore from "expo-secure-store";

export const tokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      // Delete the corrupted entry so Clerk treats the user as signed out
      // rather than looping on a bad token.
      await SecureStore.deleteItemAsync(key);
      return null;
    }
  },

  async saveToken(key: string, value: string) {
    try {
      return await SecureStore.setItemAsync(key, value);
    } catch {
      return; // Silently fail — Clerk will re-fetch tokens if needed
    }
  },
};
