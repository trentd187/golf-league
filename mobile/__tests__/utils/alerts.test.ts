// __tests__/utils/alerts.test.ts
// Tests for the platform-aware alert utilities in utils/alerts.ts.
//
// Strategy: test both native and web branches by toggling Platform.OS.
// window.confirm / window.alert don't exist in the React Native test environment,
// so they are assigned directly on globalThis before each web test.

import { Alert, Platform } from "react-native";
import { showAlert, showConfirm } from "@/utils/alerts";

const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

// Helpers to install / remove browser stubs on globalThis.
function installWindowStubs(confirmReturnValue = false) {
  const mockConfirm = jest.fn().mockReturnValue(confirmReturnValue);
  const mockAlert = jest.fn();
  (globalThis as unknown as Record<string, unknown>).window = {
    confirm: mockConfirm,
    alert: mockAlert,
  };
  return { mockConfirm, mockAlert };
}

function removeWindowStubs() {
  (globalThis as unknown as Record<string, unknown>).window = undefined;
}

function setOS(os: string) {
  Object.defineProperty(Platform, "OS", { value: os, configurable: true, writable: true });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── showAlert — native ───────────────────────────────────────────────────────

describe("showAlert (native)", () => {
  beforeEach(() => setOS("ios"));

  it("calls Alert.alert with title and message", () => {
    showAlert("Error", "Something broke");
    expect(alertSpy).toHaveBeenCalledWith("Error", "Something broke", [{ text: "OK" }]);
  });

  it("calls Alert.alert with title only when message is omitted", () => {
    showAlert("Error");
    expect(alertSpy).toHaveBeenCalledWith("Error", undefined, [{ text: "OK" }]);
  });
});

// ─── showAlert — web ─────────────────────────────────────────────────────────

describe("showAlert (web)", () => {
  beforeEach(() => setOS("web"));
  afterEach(() => removeWindowStubs());

  it("calls window.alert with combined title and message", () => {
    const { mockAlert } = installWindowStubs();
    showAlert("Error", "Something broke");
    expect(mockAlert).toHaveBeenCalledWith("Error: Something broke");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("calls window.alert with title only when message is omitted", () => {
    const { mockAlert } = installWindowStubs();
    showAlert("Error");
    expect(mockAlert).toHaveBeenCalledWith("Error");
  });
});

// ─── showConfirm — native ─────────────────────────────────────────────────────

describe("showConfirm (native)", () => {
  beforeEach(() => setOS("ios"));

  it("calls Alert.alert with cancel and confirm buttons", () => {
    const onConfirm = jest.fn();
    showConfirm("Delete?", "This cannot be undone.", onConfirm, "Delete", "Cancel");
    expect(alertSpy).toHaveBeenCalledWith(
      "Delete?",
      "This cannot be undone.",
      expect.arrayContaining([
        expect.objectContaining({ text: "Cancel", style: "cancel" }),
        expect.objectContaining({ text: "Delete", style: "destructive" }),
      ]),
    );
  });

  it("does not call onConfirm at call time (waits for user button press)", () => {
    const onConfirm = jest.fn();
    showConfirm("Title", "Message", onConfirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("uses default button labels when not specified", () => {
    showConfirm("Title", "Message", jest.fn());
    expect(alertSpy).toHaveBeenCalledWith(
      "Title",
      "Message",
      expect.arrayContaining([
        expect.objectContaining({ text: "Cancel" }),
        expect.objectContaining({ text: "OK" }),
      ]),
    );
  });
});

// ─── showConfirm — web ───────────────────────────────────────────────────────

describe("showConfirm (web)", () => {
  beforeEach(() => setOS("web"));
  afterEach(() => removeWindowStubs());

  it("calls window.confirm with title and message", () => {
    const { mockConfirm } = installWindowStubs(false);
    showConfirm("Delete?", "Cannot be undone.", jest.fn());
    expect(mockConfirm).toHaveBeenCalledWith("Delete?\n\nCannot be undone.");
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("calls onConfirm when window.confirm returns true", () => {
    installWindowStubs(true);
    const onConfirm = jest.fn();
    showConfirm("Title", "Message", onConfirm);
    expect(onConfirm).toHaveBeenCalled();
  });

  it("does not call onConfirm when window.confirm returns false", () => {
    installWindowStubs(false);
    const onConfirm = jest.fn();
    showConfirm("Title", "Message", onConfirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
