// components/TimeInput.tsx
// A reusable tee-time field that mirrors DateInput's API for times:
//   - A themed touchable showing the selected time ("h:mm AM/PM") or a placeholder
//   - Tapping it opens the platform native time picker
//   - Optional clear (X) button when a value is set
//
// Times are stored in "HH:MM" (24-hour) form — the same format used by the backend
// round/group APIs and by HTML <input type="time"> (see TimeInput.web.tsx). Pure
// conversion lives in utils/teeTime.ts.
//
// Picker behavior:
//   - Android: native dialog appears automatically
//   - iOS: bottom-sheet Modal with a spinner-style picker

import { useState } from "react";
import { View, Text, TouchableOpacity, Modal, Platform } from "react-native";
import DateTimePicker, {
  DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { teeTimeToDate, dateToTeeTime, formatTeeTime } from "@/utils/teeTime";

interface TimeInputProps {
  value: string;        // "HH:MM" 24-hour, or ""
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string; // default "Set tee time (optional)"
  pickerTitle?: string; // iOS sheet header; defaults to label or "Tee Time"
  disabled?: boolean;
  clearable?: boolean;  // show an X to clear the value when set
}

export default function TimeInput({
  value,
  onChange,
  label,
  placeholder = "Set tee time (optional)",
  pickerTitle,
  disabled,
  clearable,
}: TimeInputProps) {
  const [showPicker, setShowPicker] = useState(false);
  const t = useTheme();

  const handlePickerChange = (event: DateTimePickerEvent, date?: Date) => {
    if (Platform.OS === "android") {
      setShowPicker(false);
      // event.type === "set" means the user confirmed (not "dismissed" = cancelled)
      if (event.type === "set" && date) onChange(dateToTeeTime(date));
    } else if (date) {
      onChange(dateToTeeTime(date));
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
        onPress={() => setShowPicker(true)}
        disabled={disabled}
        activeOpacity={0.7}
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

      {/* ── Native time picker ────────────────────────────────────────────────
          Android: mount DateTimePicker directly — it shows its own native dialog.
          iOS: wrap it in a Modal bottom sheet since it has no built-in dialog mode. */}

      {Platform.OS === "android" && showPicker && (
        <DateTimePicker
          value={teeTimeToDate(value)}
          mode="time"
          display="default"
          is24Hour={false}
          onChange={handlePickerChange}
        />
      )}

      {Platform.OS === "ios" && (
        <Modal
          visible={showPicker}
          transparent
          animationType="slide"
          onRequestClose={() => setShowPicker(false)}
        >
          <View className="flex-1">
            {/* Backdrop — tap to close */}
            <TouchableOpacity
              className="absolute inset-0 bg-black/40"
              activeOpacity={1}
              onPress={() => setShowPicker(false)}
            />

            <View className={`absolute bottom-0 left-0 right-0 ${t.surface} rounded-t-2xl pb-8`}>
              <View className={`flex-row items-center justify-between px-5 pt-4 pb-2 border-b ${t.divider}`}>
                <Text className={`font-semibold ${t.textSecondary}`}>
                  {pickerTitle ?? label ?? "Tee Time"}
                </Text>
                <TouchableOpacity onPress={() => setShowPicker(false)}>
                  <Text className="font-semibold text-base" style={{ color: t.colors.tabBarActive }}>
                    Done
                  </Text>
                </TouchableOpacity>
              </View>

              <DateTimePicker
                value={teeTimeToDate(value)}
                mode="time"
                display="spinner"
                onChange={handlePickerChange}
                // eslint-disable-next-line react-native/no-inline-styles
                style={{ height: 200 }}
              />
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}
