// __tests__/utils/persistStorage.test.ts
// Unit tests for utils/persistStorage.ts — the storage adapter behind both persisted Zustand
// stores (theme, list prefs).
//
// Two contracts, and the tests exist because the old hand-rolled adapters honoured only one:
//
//   1. NEVER THROW. A storage failure degrades to defaults; it must not crash the app.
//   2. NEVER SWALLOW SILENTLY. The old `.catch(() => {})` met contract 1 and violated 2: a
//      persistently failing WRITE meant the user's theme and list prefs never saved — they
//      reverted on every launch — and nothing anywhere said so. "Degrade gracefully" and
//      "degrade invisibly" are not the same thing.

import { createPersistStorage, type AsyncKeyValueStore } from "@/utils/persistStorage";

const report = jest.fn();

// A store whose every method rejects — the "SecureStore is broken / localStorage is blocked" case.
const brokenStore: AsyncKeyValueStore = {
  getItemAsync: () => Promise.reject(new Error("SecurityError: storage is blocked")),
  setItemAsync: () => Promise.reject(new Error("QuotaExceededError")),
  deleteItemAsync: () => Promise.reject(new Error("boom")),
};

const workingStore: AsyncKeyValueStore = {
  getItemAsync: jest.fn().mockResolvedValue('{"state":{"themeName":"dark"}}'),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
};

beforeEach(() => jest.clearAllMocks());

describe("createPersistStorage — happy path", () => {
  it("passes reads, writes, and removes straight through", async () => {
    const storage = createPersistStorage(workingStore, "theme", report);

    await expect(storage.getItem("k")).resolves.toBe('{"state":{"themeName":"dark"}}');
    await storage.setItem("k", "v");
    await storage.removeItem("k");

    expect(workingStore.setItemAsync).toHaveBeenCalledWith("k", "v");
    expect(workingStore.deleteItemAsync).toHaveBeenCalledWith("k");
    expect(report).not.toHaveBeenCalled();
  });
});

describe("createPersistStorage — failures degrade AND report", () => {
  it("returns null (not a throw) on a failed read, and reports it", async () => {
    const storage = createPersistStorage(brokenStore, "theme", report);

    await expect(storage.getItem("theme-storage")).resolves.toBeNull();

    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: "theme", operation: "read", key: "theme-storage" }),
    );
  });

  // The one that matters. A failing write means the preference the user just set will not
  // survive the next launch — and they will never be told. It must at least reach telemetry.
  it("resolves (not throws) on a failed write, and reports it", async () => {
    const storage = createPersistStorage(brokenStore, "list_prefs", report);

    await expect(storage.setItem("list-prefs-storage", "{}")).resolves.toBeUndefined();

    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: "list_prefs", operation: "write" }),
    );
  });

  it("resolves (not throws) on a failed remove, and reports it", async () => {
    const storage = createPersistStorage(brokenStore, "theme", report);

    await expect(storage.removeItem("k")).resolves.toBeUndefined();

    expect(report).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: "remove" }),
    );
  });

  // Regression for the platformStorage web adapter: localStorage's methods throw
  // SYNCHRONOUSLY. The old adapters wrapped them in non-async arrows returning
  // Promise.resolve(localStorage.getItem(key)), so the throw escaped BEFORE a promise existed
  // and the `.catch()` guard could never see it. A sync throw must be caught here too.
  it("catches a SYNCHRONOUS throw, not just a rejected promise", async () => {
    const syncThrower: AsyncKeyValueStore = {
      getItemAsync: () => {
        throw new Error("SecurityError");
      },
      setItemAsync: () => {
        throw new Error("SecurityError");
      },
      deleteItemAsync: () => {
        throw new Error("SecurityError");
      },
    };
    const storage = createPersistStorage(syncThrower, "theme", report);

    await expect(storage.getItem("k")).resolves.toBeNull();
    await expect(storage.setItem("k", "v")).resolves.toBeUndefined();

    expect(report).toHaveBeenCalledTimes(2);
  });
});
