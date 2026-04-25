// __tests__/components/UserSearchList.test.tsx
// Tests for the UserSearchList component's rendering modes.
//
// Covers:
//   - Loading state (users undefined) → spinner
//   - Empty state (users = []) → empty message
//   - User row with avatar_url → Image rendered, no initials (bug fix: avatar_url
//     was previously missing from UserSummary type and never rendered)
//   - User row without avatar_url → initials rendered, no Image

import React from "react";
import { Image } from "react-native";
import { render } from "@testing-library/react-native";
import UserSearchList, { UserSummary } from "@/components/UserSearchList";

// useTheme is called inside UserSearchList — mock it to return stable stub values
// so the component renders without needing a real theme store.
jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    borderInput: "",
    surfaceSunken: "",
    textPrimary: "",
    divider: "",
    colors: { tabBarInactive: "#ccc", tabBarActive: "#15803d" },
  }),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const noop = () => {};

const userWithAvatar: UserSummary = {
  id: "u1",
  display_name: "Alice Smith",
  email: "alice@example.com",
  avatar_url: "https://example.com/alice.jpg",
};

const userWithoutAvatar: UserSummary = {
  id: "u2",
  display_name: "Bob Jones",
  email: "bob@example.com",
  avatar_url: null,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

it("shows a spinner when users is undefined (loading state)", () => {
  const { UNSAFE_getByType } = render(
    <UserSearchList
      users={undefined}
      search=""
      onSearchChange={noop}
      onSelect={noop}
      isPending={false}
    />
  );
  // ActivityIndicator is the only non-text element rendered when users is undefined.
  // It does not have accessible text so we query by type.
  const { ActivityIndicator } = require("react-native");
  expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
});

it("shows the empty message when users is an empty array", () => {
  const { getByText } = render(
    <UserSearchList
      users={[]}
      search=""
      onSearchChange={noop}
      onSelect={noop}
      isPending={false}
      emptyMessage="No players yet."
    />
  );
  expect(getByText("No players yet.")).toBeTruthy();
});

it("renders an Image (not initials) for a user with avatar_url", () => {
  // This test covers the bug fix: avatar_url was missing from UserSummary and
  // was never rendered; the component always showed initials before the fix.
  const { queryByText, UNSAFE_getByType } = render(
    <UserSearchList
      users={[userWithAvatar]}
      search=""
      onSearchChange={noop}
      onSelect={noop}
      isPending={false}
    />
  );
  expect(UNSAFE_getByType(Image)).toBeTruthy();
  // The initials "A" should not appear — the Image branch is taken instead.
  expect(queryByText("A")).toBeNull();
});

it("renders initials and no Image for a user without avatar_url", () => {
  const { getByText, UNSAFE_queryByType } = render(
    <UserSearchList
      users={[userWithoutAvatar]}
      search=""
      onSearchChange={noop}
      onSelect={noop}
      isPending={false}
    />
  );
  // First letter of display_name, uppercased.
  expect(getByText("B")).toBeTruthy();
  expect(UNSAFE_queryByType(Image)).toBeNull();
});

it("filters user rows by the search query", () => {
  const { getByText, queryByText } = render(
    <UserSearchList
      users={[userWithAvatar, userWithoutAvatar]}
      search="alice"
      onSearchChange={noop}
      onSelect={noop}
      isPending={false}
    />
  );
  expect(getByText("Alice Smith")).toBeTruthy();
  // Bob does not match "alice" — his row should not be present.
  expect(queryByText("Bob Jones")).toBeNull();
});
