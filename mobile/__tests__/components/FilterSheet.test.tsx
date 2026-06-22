// __tests__/components/FilterSheet.test.tsx
// Tests the generic filter bottom sheet: it renders each section's title and
// options, reports the selected option per section, and fires onSelect /
// onClearAll callbacks.

import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import FilterSheet, { FilterSheetSection } from "@/components/FilterSheet";

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    surface: "",
    divider: "",
    textPrimary: "",
    textSecondary: "",
    textTertiary: "",
    colors: { tabBarInactive: "#9ca3af", tabBarActive: "#15803d" },
  }),
}));

const noop = () => {};

function buildSections(onSelect = noop): FilterSheetSection[] {
  return [
    {
      key: "type",
      title: "Event Type",
      options: [
        { value: "all", label: "All Types" },
        { value: "league", label: "League" },
      ],
      selected: "league",
      onSelect,
    },
    {
      key: "status",
      title: "Status",
      options: [
        { value: "all", label: "All Status" },
        { value: "active", label: "Active" },
      ],
      selected: "all",
      onSelect: noop,
    },
  ];
}

it("renders all section titles and options", () => {
  const { getByText } = render(
    <FilterSheet visible onClose={noop} sections={buildSections()} onClearAll={noop} showClearIcon={false} />,
  );
  expect(getByText("Event Type")).toBeTruthy();
  expect(getByText("Status")).toBeTruthy();
  expect(getByText("League")).toBeTruthy();
  expect(getByText("All Status")).toBeTruthy();
});

it("fires the matching section's onSelect with the tapped value", () => {
  const onSelect = jest.fn();
  const { getByText } = render(
    <FilterSheet visible onClose={noop} sections={buildSections(onSelect)} onClearAll={noop} showClearIcon={false} />,
  );
  fireEvent.press(getByText("All Types"));
  expect(onSelect).toHaveBeenCalledWith("all");
});

it("fires onClearAll when the Clear All row is pressed", () => {
  const onClearAll = jest.fn();
  const { getByText } = render(
    <FilterSheet visible onClose={noop} sections={buildSections()} onClearAll={onClearAll} showClearIcon />,
  );
  fireEvent.press(getByText("Clear All"));
  expect(onClearAll).toHaveBeenCalledTimes(1);
});

it("renders a section with no leading 'all' option (e.g. a single status axis)", () => {
  const sections: FilterSheetSection[] = [
    {
      key: "status",
      title: "Status",
      options: [{ value: "active", label: "Active" }],
      selected: "active",
      onSelect: noop,
    },
  ];
  const { getByText } = render(
    <FilterSheet visible onClose={noop} sections={sections} onClearAll={noop} showClearIcon={false} />,
  );
  expect(getByText("Active")).toBeTruthy();
});
