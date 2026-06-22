// __tests__/components/SortSheet.test.tsx
// Tests the generic sort bottom sheet: it renders every option label and fires
// onSelect with the chosen value.

import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import SortSheet, { SortSheetOption } from "@/components/SortSheet";

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    surface: "",
    divider: "",
    textPrimary: "",
    textSecondary: "",
    colors: { tabBarInactive: "#9ca3af", tabBarActive: "#15803d" },
  }),
}));

const noop = () => {};

const options: SortSheetOption[] = [
  { value: "date_desc", label: "Date (latest first)" },
  { value: "name_asc", label: "Name (A–Z)" },
];

it("renders every sort option label", () => {
  const { getByText } = render(
    <SortSheet visible onClose={noop} options={options} selected="date_desc" onSelect={noop} />,
  );
  expect(getByText("Date (latest first)")).toBeTruthy();
  expect(getByText("Name (A–Z)")).toBeTruthy();
});

it("fires onSelect with the tapped option value", () => {
  const onSelect = jest.fn();
  const { getByText } = render(
    <SortSheet visible onClose={noop} options={options} selected="date_desc" onSelect={onSelect} />,
  );
  fireEvent.press(getByText("Name (A–Z)"));
  expect(onSelect).toHaveBeenCalledWith("name_asc");
});

it("tolerates options carrying extra fields (only value/label are read)", () => {
  const richOptions = [
    { value: "date_desc", label: "Date (latest first)", shortLabel: "Date ↓" },
    { value: "name_asc", label: "Name (A–Z)", shortLabel: "A–Z" },
  ];
  const { getByText } = render(
    <SortSheet visible onClose={noop} options={richOptions} selected="name_asc" onSelect={noop} />,
  );
  expect(getByText("Date (latest first)")).toBeTruthy();
});
