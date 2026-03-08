// components/DateInput.tsx
// A reusable date input field that combines:
//   1. A formatted text input — auto-inserts dashes as the user types (MM-DD-YY)
//   2. A calendar icon button — opens the platform's native date picker
//   3. Inline error feedback — red border + message if the typed date is invalid
//
// Usage:
//   <DateInput label="Start Date" optional value={startDate} onChange={setStartDate} />
//
// Dates are stored in MM-DD-YY format in form state. Use apiToDisplay() and displayToApi()
// to convert to/from YYYY-MM-DD (the backend format).
//
// Calendar picker behavior:
//   - Android: native dialog appears automatically
//   - iOS: bottom sheet modal slides up with a spinner-style picker

import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  Platform,
} from "react-native";
// DateTimePicker renders a platform-native date/time UI on both iOS and Android.
import DateTimePicker, {
  DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";

// ─── Date conversion utilities ────────────────────────────────────────────────

// apiToDisplay: "YYYY-MM-DD" → "MM-DD-YY". Returns "" for null/undefined/empty.
export function apiToDisplay(isoDate: string | null | undefined): string {
  if (!isoDate) return "";
  const parts = isoDate.split("-");
  if (parts.length !== 3) return "";
  const [year, month, day] = parts;
  return `${month}-${day}-${year.slice(2)}`; // "2026" → "26"
}

// displayToApi: "MM-DD-YY" → "YYYY-MM-DD". Returns "" for invalid/empty input.
// Century assumption: always 2000s (2000–2099).
export function displayToApi(displayDate: string): string {
  if (!displayDate) return "";
  const parts = displayDate.split("-");
  if (parts.length !== 3) return "";
  const [month, day, year] = parts;
  if (month.length !== 2 || day.length !== 2 || year.length !== 2) return "";
  return `20${year}-${month}-${day}`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// isValidDisplayDate: returns false for partial input (< 8 chars) so errors
// don't show while the user is still typing.
function isValidDisplayDate(value: string): boolean {
  if (!/^\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const [m, d, y] = value.split("-").map(Number);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // JS Date validates impossible dates like Feb 30 or Nov 31.
  // getMonth() is 0-based — mismatch means the day overflowed into the next month.
  const date = new Date(2000 + y, m - 1, d);
  return date.getMonth() === m - 1 && date.getDate() === d;
}

// autoFormat: strips non-digits and inserts dashes so the user never types them.
// "0301" → "03-01",  "030126" → "03-01-26"
function autoFormat(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 6);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

// toPickerDate: MM-DD-YY → JS Date for the picker's initial value. Falls back to today.
function toPickerDate(value: string): Date {
  if (isValidDisplayDate(value)) {
    const [m, d, y] = value.split("-").map(Number);
    return new Date(2000 + y, m - 1, d);
  }
  return new Date();
}

// fromPickerDate: JS Date → MM-DD-YY. padStart ensures single digits are zero-padded.
function fromPickerDate(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const y = String(date.getFullYear()).slice(-2); // "2026" → "26"
  return `${m}-${d}-${y}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface DateInputProps {
  value: string;       // MM-DD-YY or ""
  onChange: (value: string) => void;
  label?: string;
  required?: boolean;  // shows a red asterisk after the label
  optional?: boolean;  // shows "(optional)" after the label
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
  const [showPicker, setShowPicker] = useState(false);
  const t = useTheme();

  // Show error only when the user has typed a full 8-char date that isn't valid.
  const showError = value.length === 8 && !isValidDisplayDate(value);

  const handleTextChange = (raw: string) => {
    onChange(autoFormat(raw));
  };

  // handlePickerChange behavior differs by platform:
  //   Android: fires once when the user confirms or cancels the native dialog
  //   iOS:     fires continuously as the user scrolls the spinner wheel
  const handlePickerChange = (event: DateTimePickerEvent, date?: Date) => {
    if (Platform.OS === "android") {
      setShowPicker(false);
      // event.type === "set" means confirmed (not "dismissed" = cancelled)
      if (event.type === "set" && date) {
        onChange(fromPickerDate(date));
      }
    } else {
      if (date) onChange(fromPickerDate(date));
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
          onPress={() => setShowPicker(true)}
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

      {/* ── Native date picker ────────────────────────────────────────────────
          Android: mount DateTimePicker directly — it shows its own native dialog.
          iOS: wrap it in a Modal bottom sheet since it has no built-in dialog mode. */}

      {Platform.OS === "android" && showPicker && (
        <DateTimePicker
          value={toPickerDate(value)}
          mode="date"
          display="default"
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
                <Text className={`font-semibold ${t.textSecondary}`}>Select Date</Text>
                <TouchableOpacity onPress={() => setShowPicker(false)}>
                  {/* "Done" uses theme hex — inline style required for Text color */}
                  <Text
                    className="font-semibold text-base"
                    // eslint-disable-next-line react-native/no-inline-styles
                    style={{ color: t.colors.tabBarActive }}
                  >
                    Done
                  </Text>
                </TouchableOpacity>
              </View>

              {/* DateTimePicker needs an explicit pixel height to render in a flex layout on iOS. */}
              <DateTimePicker
                value={toPickerDate(value)}
                mode="date"
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
