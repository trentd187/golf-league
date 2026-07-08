// __tests__/components/AdvancedStatPillRow.test.tsx
// Behaviour tests for the memoized advanced-stat pill row: it renders the section label
// and every option, fires onSelect only when editable, and shows/toggles the additive OB
// pill. The memoization itself (its reason for existing) is a rendering-isolation concern
// exercised in the scorecard screen, not here — these cover the interaction contract.

import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { AdvancedStatPillRow, type PillOption } from "@/components/AdvancedStatPillRow";
import type { Theme } from "@/themes";

// Minimal theme stub — only the token slots the component reads. Cast because the row
// takes the whole Theme but touches just these fields.
const t = {
  divider: "",
  textTertiary: "",
  surface: "",
  border: "",
  textSecondary: "",
  colors: { tabBarActive: "#15803d" },
} as unknown as Theme;

const OPTIONS: PillOption[] = [
  { key: "hit", label: "Hit", icon: null },
  { key: "miss:left", label: "Left", icon: null },
];

const noop = () => {};

it("renders the label and every option", () => {
  const { getByText } = render(
    <AdvancedStatPillRow t={t} label="Green in Regulation" options={OPTIONS} activeKey={null} canEdit onSelect={noop} />,
  );
  expect(getByText("Green in Regulation")).toBeTruthy();
  expect(getByText("Hit")).toBeTruthy();
  expect(getByText("Left")).toBeTruthy();
});

it("fires onSelect with the tapped option key when editable", () => {
  const onSelect = jest.fn();
  const { getByText } = render(
    <AdvancedStatPillRow t={t} label="GIR" options={OPTIONS} activeKey={null} canEdit onSelect={onSelect} />,
  );
  fireEvent.press(getByText("Left"));
  expect(onSelect).toHaveBeenCalledWith("miss:left");
});

it("does not fire onSelect when canEdit is false", () => {
  const onSelect = jest.fn();
  const { getByText } = render(
    <AdvancedStatPillRow t={t} label="GIR" options={OPTIONS} activeKey={null} canEdit={false} onSelect={onSelect} />,
  );
  fireEvent.press(getByText("Hit"));
  expect(onSelect).not.toHaveBeenCalled();
});

it("does not fire onSelect when the whole section is disabled (par 3 FIR)", () => {
  const onSelect = jest.fn();
  const { getByText } = render(
    <AdvancedStatPillRow t={t} label="Fairway in Regulation" sectionDisabled disabledSuffix=" (N/A — par 3)" options={OPTIONS} activeKey={null} canEdit onSelect={onSelect} />,
  );
  fireEvent.press(getByText("Hit"));
  expect(onSelect).not.toHaveBeenCalled();
});

it("appends the disabled suffix to the label only when the section is disabled", () => {
  const { getByText, rerender } = render(
    <AdvancedStatPillRow t={t} label="Fairway in Regulation" sectionDisabled disabledSuffix=" (N/A — par 3)" options={OPTIONS} activeKey={null} canEdit onSelect={noop} />,
  );
  expect(getByText("Fairway in Regulation (N/A — par 3)")).toBeTruthy();
  rerender(
    <AdvancedStatPillRow t={t} label="Fairway in Regulation" disabledSuffix=" (N/A — par 3)" options={OPTIONS} activeKey={null} canEdit onSelect={noop} />,
  );
  expect(getByText("Fairway in Regulation")).toBeTruthy();
});

it("renders and toggles the OB pill only when showOb is set", () => {
  const onToggleOb = jest.fn();
  const { queryByText, getByText, rerender } = render(
    <AdvancedStatPillRow t={t} label="GIR" options={OPTIONS} activeKey={null} canEdit onSelect={noop} />,
  );
  expect(queryByText("OB")).toBeNull();

  rerender(
    <AdvancedStatPillRow t={t} label="GIR" options={OPTIONS} activeKey={null} canEdit onSelect={noop} showOb obActive={false} onToggleOb={onToggleOb} />,
  );
  fireEvent.press(getByText("OB"));
  expect(onToggleOb).toHaveBeenCalledTimes(1);
});

it("does not toggle OB when not editable", () => {
  const onToggleOb = jest.fn();
  const { getByText } = render(
    <AdvancedStatPillRow t={t} label="GIR" options={OPTIONS} activeKey={null} canEdit={false} onSelect={noop} showOb obActive={false} onToggleOb={onToggleOb} />,
  );
  fireEvent.press(getByText("OB"));
  expect(onToggleOb).not.toHaveBeenCalled();
});
