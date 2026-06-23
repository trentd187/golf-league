// components/DateInput.web.tsx
// Web implementation of DateInput — Metro resolves this file over DateInput.tsx on web.
//
// The external interface (props, value format MM-DD-YY) is identical to DateInput.tsx
// so all call sites work without changes. Two ways to enter a date:
//   1. Type directly in the themed field (auto-formats to MM-DD-YY, inline error)
//   2. Tap the calendar icon → the browser's native date picker
//
// The native picker uses a real <input type="date"> created via document.createElement
// (RN's JSX namespace has no HTML intrinsics, so we can't write <input> in JSX). The
// element is appended to the DOM and opened with showPicker() (Chrome/Edge/Safari);
// a detached .click() never reliably opens the picker, which was the original web bug.

import { View, Text, TextInput, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import {
  apiToDisplay,
  displayToApi,
  isValidDisplayDate,
  autoFormat,
} from "@/utils/dateInput";

// Re-export so call sites importing from "@/components/DateInput.web" (and the platform
// alias "@/components/DateInput") keep resolving these converters.
export { apiToDisplay, displayToApi };

// toHtmlValue: MM-DD-YY → YYYY-MM-DD (HTML date input format).
function toHtmlValue(display: string): string {
  return displayToApi(display);
}

// fromHtmlValue: YYYY-MM-DD → MM-DD-YY.
function fromHtmlValue(html: string): string {
  return apiToDisplay(html);
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
  returnKeyType,
}: DateInputProps) {
  const t = useTheme();

  // Show error only when the user has typed a full 8-char date that isn't valid.
  const showError = value.length === 8 && !isValidDisplayDate(value);

  const handleTextChange = (raw: string) => {
    onChange(autoFormat(raw));
  };

  const handleCalendarPress = () => {
    if (disabled) return;
    // Create a real <input type="date">, attach it to the DOM (hidden), and open the
    // browser's native picker. showPicker() is the reliable path; .click() is a fallback
    // for older engines. A detached input's .click() does not open the picker.
    const input = document.createElement("input");
    input.type = "date";
    input.value = toHtmlValue(value);
    // Keep it out of layout/flow but still attached so showPicker() is allowed.
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.opacity = "0";

    const cleanup = () => {
      input.parentNode?.removeChild(input);
    };
    input.onchange = (e) => {
      const target = e.target as HTMLInputElement;
      onChange(fromHtmlValue(target.value));
      cleanup();
    };
    // Fired when the user dismisses the picker without choosing (modern browsers).
    input.oncancel = cleanup;

    document.body?.appendChild(input);
    if (typeof input.showPicker === "function") {
      input.showPicker();
    } else {
      input.click();
    }
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
        className={`flex-row items-center border rounded-xl ${t.surfaceSunken} ${
          showError ? "border-red-400" : t.borderInput
        }`}
      >
        {/* Editable so users can type MM-DD-YY directly (the calendar icon is optional). */}
        <TextInput
          className={`flex-1 px-4 py-3 text-base ${t.textPrimary}`}
          placeholder="MM-DD-YY"
          placeholderTextColor={t.colors.tabBarInactive}
          value={value}
          onChangeText={handleTextChange}
          keyboardType="numeric"
          maxLength={8}
          editable={!disabled}
          returnKeyType={returnKeyType}
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

      {showError && (
        <Text className="text-red-500 text-xs mt-1 ml-1">
          Please enter a valid date (MM-DD-YY)
        </Text>
      )}
    </View>
  );
}
