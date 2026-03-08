// components/badges.tsx
// Categorical badge and chip components used across Event and Round screens.
//
// "Categorical" means the color IS the meaning — a green chip always means "active",
// a red chip always means "cancelled". These must NOT use theme tokens, because
// swapping colors would destroy the visual encoding. See CLAUDE.md.
//
// Exports:
//   EventTypeBadge  — league (blue), tournament (amber), casual (gray)
//   StatusChip      — event lifecycle: active (green), completed (gray), cancelled (red)
//   RoleBadge       — "Organizer" pill; renders null for regular players
//   RoundStatusChip — round lifecycle: scheduled (sky), active (green), completed (gray)

import { View, Text } from "react-native";

// ─── EventTypeBadge ───────────────────────────────────────────────────────────

type EventType = "league" | "tournament" | "casual";

export function EventTypeBadge({ type }: { type: EventType }) {
  const map: Record<EventType, { bg: string; text: string }> = {
    league:     { bg: "bg-blue-100",  text: "text-blue-700" },
    tournament: { bg: "bg-amber-100", text: "text-amber-700" },
    casual:     { bg: "bg-gray-100",  text: "text-gray-600" },
  };
  const s = map[type];
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${s.bg}`}>
      <Text className={`text-xs font-semibold ${s.text}`}>{label}</Text>
    </View>
  );
}

// ─── StatusChip ───────────────────────────────────────────────────────────────

// Note: "upcoming" was removed as a valid status — events now start as "active".
// Falls back to "active" styling for any unrecognised status value.
export function StatusChip({ status }: { status: string }) {
  const map: Record<string, { bg: string; text: string }> = {
    active:    { bg: "bg-green-100", text: "text-green-700" },
    completed: { bg: "bg-gray-100",  text: "text-gray-600" },
    cancelled: { bg: "bg-red-100",   text: "text-red-600" },
  };
  const s = map[status] ?? map.active;
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${s.bg}`}>
      <Text className={`text-xs font-semibold ${s.text}`}>{label}</Text>
    </View>
  );
}

// ─── RoleBadge ────────────────────────────────────────────────────────────────

// Returns null for non-organizers — safe to always render regardless of role.
export function RoleBadge({ role }: { role: string }) {
  if (role !== "organizer") return null;
  return (
    <View className="rounded-full px-2 py-0.5 bg-green-100">
      <Text className="text-xs font-semibold text-green-700">Organizer</Text>
    </View>
  );
}

// ─── RoundStatusChip ──────────────────────────────────────────────────────────

// Falls back to "scheduled" styling for any unrecognised status value.
export function RoundStatusChip({ status }: { status: string }) {
  const map: Record<string, { bg: string; text: string }> = {
    scheduled: { bg: "bg-sky-100",   text: "text-sky-700" },
    active:    { bg: "bg-green-100", text: "text-green-700" },
    completed: { bg: "bg-gray-100",  text: "text-gray-600" },
  };
  const s = map[status] ?? map.scheduled;
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${s.bg}`}>
      <Text className={`text-xs font-semibold ${s.text}`}>{label}</Text>
    </View>
  );
}
