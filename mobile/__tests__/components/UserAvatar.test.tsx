// __tests__/components/UserAvatar.test.tsx
// Tests for the UserAvatar component's two rendering modes:
// photo (when avatarUrl is provided) and initials fallback (when not).

import React from "react";
import { Image } from "react-native";
import { render } from "@testing-library/react-native";
import UserAvatar from "@/components/UserAvatar";

it("shows first letter of displayName when no avatarUrl", () => {
  const { getByText } = render(<UserAvatar displayName="Alice" />);
  expect(getByText("A")).toBeTruthy();
});

it("shows uppercased initial regardless of input casing", () => {
  const { getByText } = render(<UserAvatar displayName="bob" />);
  expect(getByText("B")).toBeTruthy();
});

it("renders an Image and hides initials when avatarUrl is provided", () => {
  const { queryByText, UNSAFE_getByType } = render(
    <UserAvatar avatarUrl="https://example.com/avatar.jpg" displayName="Alice" />
  );
  expect(queryByText("A")).toBeNull();
  expect(UNSAFE_getByType(Image)).toBeTruthy();
});

it("shows initials when avatarUrl is null", () => {
  const { getByText } = render(<UserAvatar avatarUrl={null} displayName="Charlie" />);
  expect(getByText("C")).toBeTruthy();
});
