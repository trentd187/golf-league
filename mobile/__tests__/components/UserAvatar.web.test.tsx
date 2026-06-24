// __tests__/components/UserAvatar.web.test.tsx
// Tests the web variant of UserAvatar. Imported by explicit path because Jest uses the
// native preset (it does not apply Metro's .web.tsx platform resolution). The key
// behaviour: the photo branch renders a native <img> with loading="lazy" + decoding=
// "async" so the browser only decodes avatars near the viewport — the fix for the
// STATUS_ILLEGAL_INSTRUCTION renderer crash on avatar-heavy pages.

import React from "react";
import { render } from "@testing-library/react-native";
import UserAvatarWeb from "@/components/UserAvatar.web";

type JsonNode = {
  type: string | unknown;
  props: Record<string, unknown>;
  children: JsonNode[] | null;
} | null;

// Walks the rendered tree for the first host node with the given tag.
function findByType(node: JsonNode, type: string): JsonNode {
  if (!node) return null;
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    const found = findByType(child as JsonNode, type);
    if (found) return found;
  }
  return null;
}

it("renders a lazy, async-decoding <img> for the photo branch", () => {
  const { toJSON } = render(
    <UserAvatarWeb avatarUrl="https://example.com/avatar.jpg" displayName="Alice" size={40} />,
  );
  const img = findByType(toJSON() as JsonNode, "img");

  expect(img).not.toBeNull();
  expect(img?.props.src).toBe("https://example.com/avatar.jpg");
  expect(img?.props.loading).toBe("lazy");
  expect(img?.props.decoding).toBe("async");
  expect(img?.props.width).toBe(40);
  expect(img?.props.height).toBe(40);
});

it("renders initials (no <img>) when no avatarUrl is provided", () => {
  const { getByText, toJSON } = render(<UserAvatarWeb displayName="bob" />);
  expect(getByText("B")).toBeTruthy();
  expect(findByType(toJSON() as JsonNode, "img")).toBeNull();
});

it("renders initials when avatarUrl is null", () => {
  const { getByText } = render(<UserAvatarWeb avatarUrl={null} displayName="Charlie" />);
  expect(getByText("C")).toBeTruthy();
});
