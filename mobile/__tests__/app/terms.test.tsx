// __tests__/app/terms.test.tsx
// Tests for the Terms of Service screen.
//
// Covers:
//   - All major section headings render
//   - Back button calls router.back()

import React from "react";
import { render, fireEvent } from "@testing-library/react-native";

const mockBack = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: mockBack }),
}));

jest.mock("@expo/vector-icons/Ionicons", () => "Ionicons");

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    screen: "bg-white",
    surface: "bg-white",
    border: "border-gray-200",
    textPrimary: "text-gray-900",
    textSecondary: "text-gray-600",
    textTertiary: "text-gray-400",
    colors: { tabBarActive: "#15803d", tabBarInactive: "#9ca3af" },
  }),
}));

import TermsScreen from "@/app/terms";

describe("TermsScreen", () => {
  beforeEach(() => {
    mockBack.mockClear();
  });

  it("renders the Terms of Service title", () => {
    const { getByText } = render(<TermsScreen />);
    expect(getByText("Terms of Service")).toBeTruthy();
    expect(getByText("Golf Stuff In Here")).toBeTruthy();
  });

  it("renders all 18 section headings", () => {
    const { getByText } = render(<TermsScreen />);
    expect(getByText(/1\. Acceptance of Terms/)).toBeTruthy();
    expect(getByText(/2\. Eligibility/)).toBeTruthy();
    expect(getByText(/3\. Your Account/)).toBeTruthy();
    expect(getByText(/4\. User Content/)).toBeTruthy();
    expect(getByText(/5\. Acceptable Use/)).toBeTruthy();
    expect(getByText(/6\. Third-Party Services/)).toBeTruthy();
    expect(getByText(/7\. Golf Data and Handicaps/)).toBeTruthy();
    expect(getByText(/8\. Intellectual Property/)).toBeTruthy();
    expect(getByText(/9\. Privacy/)).toBeTruthy();
    expect(getByText(/10\. Disclaimers/)).toBeTruthy();
    expect(getByText(/11\. Limitation of Liability/)).toBeTruthy();
    expect(getByText(/12\. Indemnification/)).toBeTruthy();
    expect(getByText(/13\. Termination/)).toBeTruthy();
    expect(getByText(/14\. Governing Law/)).toBeTruthy();
    expect(getByText(/15\. Changes to These Terms/)).toBeTruthy();
    expect(getByText(/16\. Severability/)).toBeTruthy();
    expect(getByText(/17\. Entire Agreement/)).toBeTruthy();
    expect(getByText(/18\. Contact Us/)).toBeTruthy();
  });

  it("calls router.back() when the back button is pressed", () => {
    const { getByLabelText } = render(<TermsScreen />);
    fireEvent.press(getByLabelText("Go back"));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("renders the Missouri governing law clause", () => {
    const { getByText } = render(<TermsScreen />);
    expect(getByText(/State of Missouri/)).toBeTruthy();
  });

  it("renders the handicap disclaimer", () => {
    const { getByText } = render(<TermsScreen />);
    expect(getByText(/does not calculate or issue official World Handicap System/)).toBeTruthy();
  });
});
