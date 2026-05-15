// components/DateInput.web.tsx
// Web implementation of DateInput — Metro resolves this file over DateInput.tsx on web.
//
// Uses an imperatively created <input type="date"> (YYYY-MM-DD) instead of the native
// date picker. The external interface (props, value format MM-DD-YY) is identical to
// DateInput.tsx so all call sites work without changes.
//
// HTML elements are created via document.createElement rather than JSX because the
// TypeScript JSX namespace is React Native's, which doesn't include HTML intrinsics.
// This is the same pattern used in profile.tsx's web image picker.

import { View, Text, TextInput, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

// ─── Date conversion utilities ────────────────────────────────────────────────
// Duplicated from DateInput.tsx — importing from "./DateInput" on web would import
// this file itself (Metro's platform resolution), creating a circular dependency.
// These are pure functions with no dependencies; duplication is safe.

export function apiToDisplay(isoDate: string | null | undefined): string {
  if (!isoDate) return "";
  const parts = isoDate.split("-");
  if (parts.length !== 3) return "";
  const [year, month, day] = parts;
  return `${month}-${day}-${year.slice(2)}`;
}

export function displayToApi(displayDate: string): string {
  if (!displayDate) return "";
  const parts = displayDate.split("-");
  if (parts.length !== 3) return "";
  const [month, day, year] = parts;
  if (month.length !== 2 || day.length !== 2 || year.length !== 2) return "";
  return `20${year}-${month}-${day}`;
}

// toHtmlValue: MM-DD-YY → YYYY-MM-DD (HTML date input format).
function toHtmlValue(display: string): string {
  return displayToApi(display);
}

// fromHtmlValue: YYYY-MM-DD → MM-DD-YY.
function fromHtmlValue(html: string): string {
  if (!html) return "";
  const parts = html.split("-");
  if (parts.length !== 3) return "";
  const [year, month, day] = parts;
  return `${month}-${day}-${year.slice(2)}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface DateInputProps {
  value: string;       // MM-DD-YY or ""
  onChange: (value: string) => void;
  label?: string;
  required?: boolean;
  optional?: boolean;
  disabled?: boolean;
  returnKeyType?: "done" | "next" | "go" | "search" | "send";
}

export default function DateInput({
  value,
  onChange,
  label,
  required,
  optional,
  disabled,
}: DateInputProps) {
  const t = useTheme();

  const handleCalendarPress = () => {
    // Create a hidden <input type="date"> and click it programmatically.
    // The browser's native date picker opens without any JSX HTML intrinsics.
    const input = document.createElement("input");
    input.type = "date";
    input.value = toHtmlValue(value);
    if (disabled) return;
    input.onchange = (e) => {
      const target = e.target as HTMLInputElement;
      onChange(fromHtmlValue(target.value));
    };
    input.click();
  };

  return (
    <View>
      {label && (
        <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
          {label}{" "}
          {required && <Text className="text-red-500">*</Text>}
          {optional && (
            <Text className={`normal-case font-normal ${t.textTertiary}`}>
              (optional)
            </Text>
          )}
        </Text>
      )}

      <View
        className={`flex-row items-center border rounded-xl ${t.surfaceSunken} ${t.borderInput}`}
      >
        {/* Display the current value in MM-DD-YY format to match the native component. */}
        <TextInput
          className={`flex-1 px-4 py-3 text-base ${t.textPrimary}`}
          placeholder="MM-DD-YY"
          placeholderTextColor={t.colors.tabBarInactive}
          value={value}
          editable={false}
          pointerEvents="none"
        />

        <TouchableOpacity
          className="px-3 py-3"
          onPress={handleCalendarPress}
          disabled={disabled}
          hitSlop={8}
          accessibilityLabel="Open date picker"
        >
          <Ionicons
            name="calendar-outline"
            size={20}
            color={disabled ? "#d1d5db" : t.colors.tabBarInactive}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}
