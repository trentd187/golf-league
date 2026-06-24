// stores/listPrefsStore.ts
// Zustand store that remembers each list screen's filter + sort selection and
// persists it across app restarts (the "remember my selection" requirement).
//
// One store holds a slice per list screen (events, rounds) so the persistence
// adapter, boot read, and rehydration are written once and shared. Adding a new
// filterable list = add a slice + a default + a setter; storage is free.
//
// Mirrors stores/themeStore.ts: persist middleware over platformStorage
// (SecureStore native / localStorage web) + a synchronous boot read so the
// correct selection is present on the very first render — without it the list
// would flash the default ordering then jump when async rehydration lands.

import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Sentry from "@sentry/react-native";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { platformStorage } from "@/utils/platformStorage";
import type { EventTypeFilter, EventStatusFilter, EventSortKey } from "@/utils/eventFilters";
import type { RoundStatusFilter, RoundFormatFilter, RoundSortKey } from "@/utils/roundFilters";

const STORAGE_KEY = "list-prefs-storage";

// ─── Slice shapes + defaults ────────────────────────────────────────────────────

export interface EventListPrefs {
  typeFilter: EventTypeFilter;
  statusFilter: EventStatusFilter;
  sortKey: EventSortKey;
}

export interface RoundListPrefs {
  statusFilter: RoundStatusFilter;
  formatFilter: RoundFormatFilter;
  sortKey: RoundSortKey;
}

// Events default to "active" status so the list opens on in-progress events;
// rounds default to all statuses, newest-scheduled first (matches the API order).
export const EVENT_PREFS_DEFAULT: EventListPrefs = {
  typeFilter: "all",
  statusFilter: "active",
  sortKey: "start_date_asc",
};

export const ROUND_PREFS_DEFAULT: RoundListPrefs = {
  statusFilter: "all",
  formatFilter: "all",
  sortKey: "date_desc",
};

// ─── Sync boot read ─────────────────────────────────────────────────────────────
// Read persisted prefs before any component renders. On web SecureStore is
// unavailable (the async localStorage rehydrate fills in shortly after); any
// parse failure falls back to defaults so a corrupt store never blocks boot.
function readStoredPrefs(): { events: EventListPrefs; rounds: RoundListPrefs } {
  const fallback = { events: EVENT_PREFS_DEFAULT, rounds: ROUND_PREFS_DEFAULT };
  if (Platform.OS === "web") return fallback;
  try {
    const raw = SecureStore.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as {
        state?: { events?: Partial<EventListPrefs>; rounds?: Partial<RoundListPrefs> };
      };
      return {
        // Spread defaults first so a stored slice missing a newly-added field
        // (e.g. after a future filter is introduced) still gets a valid value.
        events: { ...EVENT_PREFS_DEFAULT, ...parsed?.state?.events },
        rounds: { ...ROUND_PREFS_DEFAULT, ...parsed?.state?.rounds },
      };
    }
  } catch (err) {
    Sentry.addBreadcrumb({
      category: "list-prefs",
      level: "debug",
      message: "list-prefs boot read failed; using defaults",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  return fallback;
}

const boot = readStoredPrefs();

// ─── Types ──────────────────────────────────────────────────────────────────────

interface ListPrefsState {
  events: EventListPrefs;
  rounds: RoundListPrefs;
  // Patch setters merge so callers update a single axis without re-specifying the rest.
  setEventPrefs: (patch: Partial<EventListPrefs>) => void;
  setRoundPrefs: (patch: Partial<RoundListPrefs>) => void;
  // "Clear filters" resets the filter axes to their defaults but keeps the chosen sort.
  resetEventFilters: () => void;
  resetRoundFilters: () => void;
}

// ─── Storage adapter ──────────────────────────────────────────────────────────────
// Matches createJSONStorage's async {getItem,setItem,removeItem}. The .catch
// guards degrade gracefully to in-memory state if storage is unavailable.
const storageAdapter = createJSONStorage(() => ({
  getItem: (key: string): Promise<string | null> =>
    platformStorage.getItemAsync(key).catch(() => null),
  setItem: (key: string, value: string): Promise<void> =>
    platformStorage.setItemAsync(key, value).catch(() => {}),
  removeItem: (key: string): Promise<void> =>
    platformStorage.deleteItemAsync(key).catch(() => {}),
}));

// ─── Store ────────────────────────────────────────────────────────────────────────

export const useListPrefsStore = create<ListPrefsState>()(
  persist(
    (set) => ({
      events: boot.events,
      rounds: boot.rounds,

      setEventPrefs: (patch) => set((s) => ({ events: { ...s.events, ...patch } })),
      setRoundPrefs: (patch) => set((s) => ({ rounds: { ...s.rounds, ...patch } })),

      resetEventFilters: () =>
        set((s) => ({
          events: { ...s.events, typeFilter: "all", statusFilter: "active" },
        })),
      resetRoundFilters: () =>
        set((s) => ({
          rounds: { ...s.rounds, statusFilter: "all", formatFilter: "all" },
        })),
    }),
    {
      name: STORAGE_KEY,
      storage: storageAdapter,
      // Only persist the data slices — not the setter functions.
      partialize: (state) => ({ events: state.events, rounds: state.rounds }),
      // Merge rehydrated values over defaults so partial stored state is repaired
      // (same reasoning as the boot read above).
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        useListPrefsStore.setState({
          events: { ...EVENT_PREFS_DEFAULT, ...state.events },
          rounds: { ...ROUND_PREFS_DEFAULT, ...state.rounds },
        });
      },
    },
  ),
);
