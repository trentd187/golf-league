// __tests__/components/FilterSortBar.test.tsx
// Tests the Filter + Sort trigger row: it shows the sort label, signals the
// active-filter state, and fires the open callbacks on tap.

import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import FilterSortBar from "@/components/FilterSortBar";

// Stub theme tokens so the component renders without the real theme store.
jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    surface: "",
    border: "",
    textSecondary: "",
    colors: { tabBarInactive: "#9ca3af" },
  }),
}));

const noop = () => {};

it("renders the current sort short label", () => {
  const { getByText } = render(
    <FilterSortBar hasActiveFilters={false} sortLabel="Date ↑" onOpenFilter={noop} onOpenSort={noop} />,
  );
  expect(getByText("Date ↑")).toBeTruthy();
});

it("shows a plain 'Filter' label when no filters are active", () => {
  const { getByText } = render(
    <FilterSortBar hasActiveFilters={false} sortLabel="Newest" onOpenFilter={noop} onOpenSort={noop} />,
  );
  // queryByText with the bullet must be absent; the plain label is present.
  expect(getByText("Filter")).toBeTruthy();
});

it("appends a bullet to the Filter label when filters are active", () => {
  const { getByText } = render(
    <FilterSortBar hasActiveFilters sortLabel="Newest" onOpenFilter={noop} onOpenSort={noop} />,
  );
  expect(getByText("Filter  •")).toBeTruthy();
});

it("fires onOpenFilter when the Filter button is pressed", () => {
  const onOpenFilter = jest.fn();
  const { getByText } = render(
    <FilterSortBar hasActiveFilters={false} sortLabel="Newest" onOpenFilter={onOpenFilter} onOpenSort={noop} />,
  );
  fireEvent.press(getByText("Filter"));
  expect(onOpenFilter).toHaveBeenCalledTimes(1);
});

it("fires onOpenSort when the Sort button is pressed", () => {
  const onOpenSort = jest.fn();
  const { getByText } = render(
    <FilterSortBar hasActiveFilters={false} sortLabel="Newest" onOpenFilter={noop} onOpenSort={onOpenSort} />,
  );
  fireEvent.press(getByText("Newest"));
  expect(onOpenSort).toHaveBeenCalledTimes(1);
});
