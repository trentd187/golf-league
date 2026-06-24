// components/TimeInput.web.tsx
// Web implementation of TimeInput — Metro resolves this over TimeInput.tsx on web.
//
// The external interface (props, "HH:MM" 24-hour value) is identical to TimeInput.tsx.
// @react-native-community/datetimepicker has no web support, which is why the time
// picker was invisible on web. Here the clock icon opens the browser's native time
// picker via a real <input type="time">: its value IS "HH:MM" 24-hour, so no conversion
// is needed. The element is attached to the DOM and opened with showPicker() (a detached
// .click() does not reliably open the picker).

import { View, Text, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { formatTeeTime } from "@/utils/teeTime";

interface TimeInputProps {
  value: string;        // "HH:MM" 24-hour, or ""
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string; // default "Set tee time (optional)"
  pickerTitle?: string; // unused on web (kept for prop parity with native)
  disabled?: boolean;
  clearable?: boolean;
}

export default function TimeInput({
  value,
  onChange,
  label,
  placeholder = "Set tee time (optional)",
  disabled,
  clearable,
}: TimeInputProps) {
  const t = useTheme();

  const handleOpenPicker = () => {
    if (disabled) return;
    const input = document.createElement("input");
    input.type = "time";
    input.value = value; // HTML time input value is already "HH:MM" 24-hour
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.opacity = "0";

    const cleanup = () => {
      input.parentNode?.removeChild(input);
    };
    input.onchange = (e) => {
      onChange((e.target as HTMLInputElement).value);
      cleanup();
    };
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
          {label}
        </Text>
      )}

      <TouchableOpacity
        className={`flex-row items-center justify-between border rounded-xl px-3 py-3 ${t.borderInput} ${t.surfaceSunken}`}
        onPress={handleOpenPicker}
        disabled={disabled}
        activeOpacity={0.7}
        accessibilityLabel="Open time picker"
      >
        <Text
          className={`flex-1 text-base ${value ? t.textPrimary : ""}`}
          style={!value ? { color: t.colors.tabBarInactive } : undefined}
        >
          {value ? formatTeeTime(value) : placeholder}
        </Text>

        {clearable && value ? (
          <TouchableOpacity onPress={() => onChange("")} hitSlop={8} disabled={disabled}>
            <Ionicons name="close-circle" size={18} color={t.colors.tabBarInactive} />
          </TouchableOpacity>
        ) : (
          <Ionicons name="time-outline" size={16} color={t.colors.tabBarInactive} />
        )}
      </TouchableOpacity>
    </View>
  );
}
