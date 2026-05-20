// __tests__/utils/platformStorage.test.ts
// Tests for the platform-conditional storage abstraction.
// Verifies that the webAdapter behaves correctly (localStorage interface),
// and that the correct adapter is exported based on Platform.OS.

// Snapshot localStorage calls in the jsdom environment that Jest runs.
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn((key: string) => store[key] ?? null),
    setItem: jest.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: jest.fn((key: string) => { delete store[key]; }),
    clear: jest.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock });

// Mock expo-secure-store so native tests don't require a native module.
const mockSecureStore = {
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
};
jest.mock("expo-secure-store", () => mockSecureStore);

// ─── Web adapter (localStorage) ───────────────────────────────────────────────
// jest.isolateModules + require() is used instead of dynamic import() because
// Jest's require() respects doMock() overrides synchronously, while dynamic
// import() requires --experimental-vm-modules to work correctly.

describe("platformStorage — web adapter (localStorage)", () => {
  let storage: { getItemAsync: (k: string) => Promise<string | null>; setItemAsync: (k: string, v: string) => Promise<void>; deleteItemAsync: (k: string) => Promise<void> };

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock("react-native", () => ({ Platform: { OS: "web" } }));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("@/utils/platformStorage");
      storage = mod.platformStorage;
    });
  });

  beforeEach(() => {
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
    localStorageMock.removeItem.mockClear();
    localStorageMock.clear();
  });

  it("getItemAsync returns null for missing key", async () => {
    const result = await storage.getItemAsync("missing");
    expect(result).toBeNull();
  });

  it("setItemAsync writes a value, getItemAsync reads it back", async () => {
    await storage.setItemAsync("theme", "dark");
    const result = await storage.getItemAsync("theme");
    expect(result).toBe("dark");
  });

  it("deleteItemAsync removes an existing key", async () => {
    await storage.setItemAsync("toDelete", "value");
    await storage.deleteItemAsync("toDelete");
    const result = await storage.getItemAsync("toDelete");
    expect(result).toBeNull();
  });

  it("returns a Promise from all methods", () => {
    expect(storage.getItemAsync("k")).toBeInstanceOf(Promise);
    expect(storage.setItemAsync("k", "v")).toBeInstanceOf(Promise);
    expect(storage.deleteItemAsync("k")).toBeInstanceOf(Promise);
  });
});

// ─── Native adapter (SecureStore) ─────────────────────────────────────────────

describe("platformStorage — native adapter (SecureStore)", () => {
  let storage: { getItemAsync: (k: string) => Promise<string | null>; setItemAsync: (k: string, v: string) => Promise<void>; deleteItemAsync: (k: string) => Promise<void> };

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
      jest.doMock("expo-secure-store", () => mockSecureStore);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require("@/utils/platformStorage");
      storage = mod.platformStorage;
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSecureStore.getItemAsync.mockResolvedValue("storedValue");
    mockSecureStore.setItemAsync.mockResolvedValue(undefined);
    mockSecureStore.deleteItemAsync.mockResolvedValue(undefined);
  });

  it("getItemAsync delegates to SecureStore.getItemAsync", async () => {
    await storage.getItemAsync("theme");
    expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("theme");
  });

  it("setItemAsync delegates to SecureStore.setItemAsync", async () => {
    await storage.setItemAsync("theme", "dark");
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith("theme", "dark");
  });

  it("deleteItemAsync delegates to SecureStore.deleteItemAsync", async () => {
    await storage.deleteItemAsync("theme");
    expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledWith("theme");
  });
});
