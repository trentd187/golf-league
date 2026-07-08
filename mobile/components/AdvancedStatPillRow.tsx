// components/AdvancedStatPillRow.tsx
// One labelled row of selectable "pills" in the Advanced scorecard's stats section —
// Fairway in Regulation, Green in Regulation, and Tee Shot Club all render through this
// single component, plus the optional additive OB pill for FIR/GIR.
//
// WHY THIS IS A MEMOIZED COMPONENT (not inline JSX): a discrete pill tap is a touch
// gesture that spans onPressIn → onPressOut. If the parent scorecard re-renders and
// reflows mid-gesture (a cellular WS reconnect invalidates the scorecard query ~1×/s →
// the 3-way merge fires setState → the huge ScrollView reconciles), the gesture is
// cancelled: the pill shows its activeOpacity dim ("indented") but onPress never fires.
// React.memo isolates this subtree so those unrelated parent re-renders don't reconcile
// the pills, and an in-flight tap survives. For the memo to hold, EVERY prop must be a
// primitive or a stable reference — so the OB pill is passed as flat primitives + a
// stable callback (never an object literal), and the parent passes stable useCallback
// dispatchers and module-level option arrays. See mobile/app/scorecard/[roundId].tsx.

import { memo } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps } from "react";
import type { Theme } from "@/themes";

type IoniconsName = ComponentProps<typeof Ionicons>["name"];

// PillOption is one selectable pill. icon is null for text-only pills (Tee Shot Club).
export interface PillOption {
  key: string;
  label: string;
  icon: IoniconsName | null;
}

export interface AdvancedStatPillRowProps {
  t: Theme;
  label: string;
  // sectionDisabled greys the whole row and makes every pill inert (FIR on a par 3).
  sectionDisabled?: boolean;
  // disabledSuffix is appended to the label when sectionDisabled (e.g. " (N/A — par 3)").
  disabledSuffix?: string;
  options: readonly PillOption[];
  // activeKey is the currently-selected option key (girKey/firKey compound key, or the
  // tee-shot-club value); null when nothing is selected.
  activeKey: string | null;
  canEdit: boolean;
  onSelect: (key: string) => void;
  // OB pill (FIR/GIR only) — passed as flat primitives + a stable callback so the memo
  // isn't defeated by an object-literal prop. Omit showOb for rows without OB (club).
  showOb?: boolean;
  obActive?: boolean;
  onToggleOb?: () => void;
}

// AdvancedStatPillRow renders the section label and a wrapping row of pills. Selecting is
// gated by canEdit + sectionDisabled here so the parent's onSelect stays a pure state
// mutation. Styling mirrors the previous inline JSX exactly (green = active, red = OB).
function AdvancedStatPillRowImpl({
  t,
  label,
  sectionDisabled = false,
  disabledSuffix = "",
  options,
  activeKey,
  canEdit,
  onSelect,
  showOb = false,
  obActive = false,
  onToggleOb,
}: AdvancedStatPillRowProps) {
  // A pill is interactive only when the row is enabled and the user can edit.
  const interactive = !sectionDisabled && canEdit;

  return (
    <View className={`px-4 py-3 gap-2 border-b ${t.divider} ${sectionDisabled ? "opacity-40" : ""}`}>
      <Text className={`text-xs font-semibold uppercase tracking-wide ${t.textTertiary}`}>
        {label}{sectionDisabled ? disabledSuffix : ""}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {options.map(({ key, label: optLabel, icon }) => {
          const active = activeKey === key;
          return (
            <TouchableOpacity
              key={key}
              onPress={() => { if (interactive) onSelect(key); }}
              className={`flex-row items-center gap-1 px-3 py-1.5 rounded-full border ${
                active ? "bg-green-700 border-green-700" : `${t.surface} ${t.border}`
              } ${!canEdit ? "opacity-50" : ""}`}
              activeOpacity={interactive ? 0.7 : 1}
            >
              {icon && (
                <Ionicons name={icon} size={12} color={active ? "white" : t.colors.tabBarActive} />
              )}
              <Text className={`text-xs font-semibold ${active ? "text-white" : t.textSecondary}`}>{optLabel}</Text>
            </TouchableOpacity>
          );
        })}
        {/* OB is additive — selectable alongside a directional pill (e.g. "left AND OB"). */}
        {showOb && (
          <>
            <View className={`w-px self-stretch border-l ${t.border} mx-1`} />
            <TouchableOpacity
              onPress={() => { if (interactive) onToggleOb?.(); }}
              className={`flex-row items-center gap-1 px-3 py-1.5 rounded-full border ${
                obActive ? "bg-red-600 border-red-600" : `${t.surface} ${t.border}`
              } ${!canEdit ? "opacity-50" : ""}`}
              activeOpacity={interactive ? 0.7 : 1}
            >
              <Text className={`text-xs font-semibold ${obActive ? "text-white" : t.textSecondary}`}>OB</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

// memo keeps the pill row from re-rendering on unrelated parent state changes (the whole
// point — see the file header). All props are primitives or stable references, so the
// default shallow comparison is correct.
export const AdvancedStatPillRow = memo(AdvancedStatPillRowImpl);
