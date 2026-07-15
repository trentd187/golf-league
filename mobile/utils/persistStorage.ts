// utils/persistStorage.ts
// The storage adapter Zustand's `persist` middleware uses, shared by every persisted store
// (stores/themeStore.ts, stores/listPrefsStore.ts).
//
// Two jobs, both learned the hard way:
//
//  1. NEVER THROW. A storage failure must degrade (fall back to defaults), not crash the app —
//     SecureStore can fail on a device with a corrupted keystore, and web localStorage throws
//     outright when blocked in an embedded/third-party context or when the quota is full.
//
//  2. NEVER SWALLOW SILENTLY. The stores each hand-rolled this adapter with bare
//     `.catch(() => {})`, so a persistently failing WRITE meant the user's theme and list
//     preferences never saved — every launch reverted them — and there was no signal anywhere.
//     "Degrade gracefully" and "degrade invisibly" are not the same thing, and CLAUDE.md asks
//     for the former.
//
// Extracted from the two stores so the behaviour is defined once and unit-tested (the stores
// themselves are thin wrappers), per the extract-first rule.

import { reportStorageFailure } from "@/utils/sentry";

// AsyncKeyValueStore is the shape of both expo-secure-store and our web localStorage adapter
// (see utils/platformStorage.ts).
export interface AsyncKeyValueStore {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
}

// PersistStorage is the { getItem, setItem, removeItem } trio Zustand's createJSONStorage wants.
export interface PersistStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

// createPersistStorage wraps a raw async store so every operation is non-throwing and every
// failure is reported. `area` names the store in telemetry (e.g. "theme", "list_prefs").
//
// `report` is injectable so tests assert on the telemetry without touching Sentry.
export function createPersistStorage(
  storage: AsyncKeyValueStore,
  area: string,
  report: typeof reportStorageFailure = reportStorageFailure,
): PersistStorage {
  return {
    // A failed READ is benign — the store falls back to its default — but it still means the
    // user's preference was silently ignored, so it's worth a breadcrumb-level signal.
    getItem: async (key) => {
      try {
        return await storage.getItemAsync(key);
      } catch (err) {
        report(err, { area, operation: "read", key });
        return null;
      }
    },

    // A failed WRITE is the one that matters: the preference the user just set will not
    // survive the next launch, and they will never be told why.
    setItem: async (key, value) => {
      try {
        await storage.setItemAsync(key, value);
      } catch (err) {
        report(err, { area, operation: "write", key });
      }
    },

    removeItem: async (key) => {
      try {
        await storage.deleteItemAsync(key);
      } catch (err) {
        report(err, { area, operation: "remove", key });
      }
    },
  };
}
