// __tests__/app/privacy.test.tsx
// Tests for the Privacy Policy screen.
//
// Covers:
//   - All major section headings render
//   - Back button calls router.back()
//   - Key disclosures are present (data collection, third parties, children)

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

import PrivacyScreen from "@/app/privacy";

describe("PrivacyScreen", () => {
  beforeEach(() => {
    mockBack.mockClear();
  });

  it("renders the Privacy Policy title", () => {
    const { getByText } = render(<PrivacyScreen />);
    expect(getByText("Privacy Policy")).toBeTruthy();
    expect(getByText("Golf Stuff In Here")).toBeTruthy();
  });

  it("renders all 12 section headings", () => {
    const { getByText } = render(<PrivacyScreen />);
    expect(getByText(/1\. Information We Collect/)).toBeTruthy();
    expect(getByText(/2\. How We Use Your Information/)).toBeTruthy();
    expect(getByText(/3\. How We Share Your Information/)).toBeTruthy();
    expect(getByText(/4\. Third-Party Service Providers/)).toBeTruthy();
    expect(getByText(/5\. Data Retention/)).toBeTruthy();
    expect(getByText(/6\. Data Security/)).toBeTruthy();
    expect(getByText(/7\. Your Rights and Choices/)).toBeTruthy();
    expect(getByText(/8\. Children's Privacy/)).toBeTruthy();
    expect(getByText(/9\. California Privacy Rights/)).toBeTruthy();
    expect(getByText(/10\. International Users/)).toBeTruthy();
    expect(getByText(/11\. Changes to This Policy/)).toBeTruthy();
    expect(getByText(/12\. Contact Us/)).toBeTruthy();
  });

  it("calls router.back() when the back button is pressed", () => {
    const { getByLabelText } = render(<PrivacyScreen />);
    fireEvent.press(getByLabelText("Go back"));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("discloses that personal information is not sold", () => {
    const { getByText } = render(<PrivacyScreen />);
    expect(getByText(/do not sell, rent, or trade your personal information/)).toBeTruthy();
  });

  it("discloses the children under 13 policy", () => {
    const { getByText } = render(<PrivacyScreen />);
    expect(getByText(/not directed to children under 13/)).toBeTruthy();
  });

  it("lists all third-party service providers", () => {
    const { getByText } = render(<PrivacyScreen />);
    expect(getByText("Supabase")).toBeTruthy();
    expect(getByText("Google")).toBeTruthy();
    expect(getByText("Grafana Cloud")).toBeTruthy();
    expect(getByText("Railway")).toBeTruthy();
    expect(getByText("GolfCourseAPI.com")).toBeTruthy();
  });

  it("discloses that no passwords are stored", () => {
    const { getByText } = render(<PrivacyScreen />);
    expect(getByText(/no passwords are stored/)).toBeTruthy();
  });
});
