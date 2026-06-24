// __tests__/components/DateInput.web.test.tsx
// Tests for the web-specific DateInput implementation.
// Verifies date format conversion, that typing auto-formats + calls onChange, and
// that the calendar button opens the browser's native picker via a DOM-attached
// <input type="date"> + showPicker().

// The React Native test environment doesn't include `document`. Provide a minimal
// mock so the component's document.createElement / body.appendChild calls work.
const mockInputEl = {
  type: "" as string,
  value: "" as string,
  style: {} as Record<string, string>,
  onchange: null as ((e: { target: { value: string } }) => void) | null,
  oncancel: null as (() => void) | null,
  parentNode: null as { removeChild: jest.Mock } | null,
  showPicker: jest.fn(),
  click: jest.fn(),
};
const mockCreateElement = jest.fn(() => mockInputEl);
const mockAppendChild = jest.fn(() => {
  // Simulate the DOM attaching the node so cleanup (removeChild) has a parent.
  mockInputEl.parentNode = { removeChild: jest.fn() };
});
(globalThis as unknown as Record<string, unknown>).document = {
  createElement: mockCreateElement,
  body: { appendChild: mockAppendChild },
};

// ─── Date utility tests ───────────────────────────────────────────────────────

import { apiToDisplay, displayToApi } from "@/components/DateInput.web";

describe("apiToDisplay (YYYY-MM-DD → MM-DD-YY)", () => {
  it("converts a valid ISO date", () => {
    expect(apiToDisplay("2026-05-14")).toBe("05-14-26");
  });

  it("returns empty string for null", () => {
    expect(apiToDisplay(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(apiToDisplay(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(apiToDisplay("")).toBe("");
  });
});

describe("displayToApi (MM-DD-YY → YYYY-MM-DD)", () => {
  it("converts a valid display date", () => {
    expect(displayToApi("05-14-26")).toBe("2026-05-14");
  });

  it("returns empty string for empty input", () => {
    expect(displayToApi("")).toBe("");
  });

  it("returns empty string for incomplete input", () => {
    expect(displayToApi("05-14")).toBe("");
  });
});

// ─── Component rendering and interaction ─────────────────────────────────────

import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import DateInput from "@/components/DateInput.web";

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    textTertiary: "text-gray-500",
    textPrimary: "text-gray-900",
    surfaceSunken: "bg-gray-50",
    borderInput: "border-gray-300",
    colors: { tabBarInactive: "#9ca3af" },
  }),
}));

beforeEach(() => {
  mockInputEl.type = "";
  mockInputEl.value = "";
  mockInputEl.style = {};
  mockInputEl.onchange = null;
  mockInputEl.oncancel = null;
  mockInputEl.parentNode = null;
  mockInputEl.showPicker.mockClear();
  mockInputEl.click.mockClear();
  mockCreateElement.mockClear();
  mockAppendChild.mockClear();
});

describe("DateInput.web component", () => {
  it("renders with a placeholder when value is empty", () => {
    const { getByPlaceholderText } = render(
      <DateInput value="" onChange={jest.fn()} />
    );
    expect(getByPlaceholderText("MM-DD-YY")).toBeTruthy();
  });

  it("displays the current value", () => {
    const { getByDisplayValue } = render(
      <DateInput value="05-14-26" onChange={jest.fn()} />
    );
    expect(getByDisplayValue("05-14-26")).toBeTruthy();
  });

  it("renders a label when provided", () => {
    const { getByText } = render(
      <DateInput value="" onChange={jest.fn()} label="Start Date" />
    );
    expect(getByText("Start Date")).toBeTruthy();
  });

  it("auto-formats typed input and calls onChange with MM-DD-YY", () => {
    const mockOnChange = jest.fn();
    const { getByPlaceholderText } = render(
      <DateInput value="" onChange={mockOnChange} />
    );
    fireEvent.changeText(getByPlaceholderText("MM-DD-YY"), "030126");
    expect(mockOnChange).toHaveBeenCalledWith("03-01-26");
  });

  it("opens the native picker via a DOM-attached input + showPicker when the calendar is pressed", () => {
    const { getByLabelText } = render(
      <DateInput value="05-14-26" onChange={jest.fn()} />
    );

    fireEvent.press(getByLabelText("Open date picker"));

    expect(mockCreateElement).toHaveBeenCalledWith("input");
    expect(mockInputEl.type).toBe("date");
    // Value must be converted to YYYY-MM-DD for the HTML date input.
    expect(mockInputEl.value).toBe("2026-05-14");
    expect(mockAppendChild).toHaveBeenCalledWith(mockInputEl);
    expect(mockInputEl.showPicker).toHaveBeenCalled();
  });

  it("calls onChange with MM-DD-YY when a date is selected", () => {
    const mockOnChange = jest.fn();
    const { getByLabelText } = render(
      <DateInput value="" onChange={mockOnChange} />
    );

    fireEvent.press(getByLabelText("Open date picker"));

    // Simulate the browser firing the change event.
    mockInputEl.onchange?.({ target: { value: "2026-06-01" } });

    expect(mockOnChange).toHaveBeenCalledWith("06-01-26");
  });

  it("does not open the picker when disabled", () => {
    const { getByLabelText } = render(
      <DateInput value="" onChange={jest.fn()} disabled />
    );

    fireEvent.press(getByLabelText("Open date picker"));

    expect(mockCreateElement).not.toHaveBeenCalled();
    expect(mockInputEl.showPicker).not.toHaveBeenCalled();
    expect(mockInputEl.click).not.toHaveBeenCalled();
  });
});
