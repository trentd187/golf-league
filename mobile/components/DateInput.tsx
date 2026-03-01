// components/DateInput.tsx
// A reusable date input field that combines:
//   1. A formatted text input — auto-inserts dashes as you type (MM-DD-YY)
//   2. A calendar icon button — tapping it opens the platform's native date picker
//   3. Inline error feedback — shows a red border + message if the typed date is invalid
//
// Usage:
//   <DateInput
//     label="Start Date"
//     optional
//     value={startDate}          // MM-DD-YY string (or "" for empty)
//     onChange={setStartDate}    // called with MM-DD-YY string
//   />
//
// Internally, dates are stored in MM-DD-YY format in form state.
// Use apiToDisplay() and displayToApi() to convert to/from the YYYY-MM-DD format
// that the backend sends and expects.
//
// Calendar picker behavior:
//   - Android: The native DatePicker dialog appears automatically (OS-provided modal)
//   - iOS: A bottom sheet modal slides up containing a spinner-style date picker

import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  Platform,
} from "react-native";
// DateTimePicker is the native date/time picker from @react-native-community/datetimepicker.
// It renders a platform-native UI on both iOS and Android.
import DateTimePicker, {
  DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import Ionicons from "@expo/vector-icons/Ionicons";

// ─── Date conversion utilities ────────────────────────────────────────────────

// Convert YYYY-MM-DD (the format the backend stores and returns) to MM-DD-YY (display format).
// Returns "" for null/undefined/empty input.
// Example: "2026-03-01" → "03-01-26"
export function apiToDisplay(isoDate: string | null | undefined): string {
  if (!isoDate) return "";
  const parts = isoDate.split("-");
  if (parts.length !== 3) return "";
  const [year, month, day] = parts;
  // Take only the last 2 digits of the year: "2026" → "26"
  return `${month}-${day}-${year.slice(2)}`;
}

// Convert MM-DD-YY (display/form format) to YYYY-MM-DD (API format).
// Returns "" for invalid or empty input.
// Example: "03-01-26" → "2026-03-01"
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

// Validate that a MM-DD-YY string represents an actual calendar date.
// Returns false for partial input (fewer than 8 chars) so we don't show errors while typing.
function isValidDisplayDate(value: string): boolean {
  // Must match exactly MM-DD-YY
  if (!/^\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const [m, d, y] = value.split("-").map(Number);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Use JS Date to catch impossible dates like Feb 30 or Nov 31
  const date = new Date(2000 + y, m - 1, d);
  // getMonth() returns 0-based — if it doesn't match, the day overflowed into the next month
  return date.getMonth() === m - 1 && date.getDate() === d;
}

// Auto-format raw user input into MM-DD-YY by stripping non-digits and inserting dashes.
// This runs on every keystroke so the user never needs to type the dashes themselves.
// Examples:
//   "0301"  → "03-01"
//   "030126" → "03-01-26"
//   "03-01" (user typed dash) → "03-01" (already formatted, stays the same)
function autoFormat(raw: string): string {
  // Strip everything that isn't a digit, then limit to 6 digits (MMDDYY)
  const digits = raw.replace(/\D/g, "").slice(0, 6);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

// Convert a validated MM-DD-YY display string to a JS Date for the picker's initial value.
// Falls back to today's date if the value is empty or invalid.
function toPickerDate(value: string): Date {
  if (isValidDisplayDate(value)) {
    const [m, d, y] = value.split("-").map(Number);
    return new Date(2000 + y, m - 1, d);
  }
  return new Date();
}

// Convert a JS Date selected by the native picker back to MM-DD-YY display format.
function fromPickerDate(date: Date): string {
  // padStart(2, "0") ensures single-digit months/days are zero-padded: 3 → "03"
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  // slice(-2) takes the last 2 chars of the year string: "2026" → "26"
  const y = String(date.getFullYear()).slice(-2);
  return `${m}-${d}-${y}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface DateInputProps {
  // The current value in MM-DD-YY format, or "" for empty.
  value: string;
  // Called whenever the value changes (from typing or picker selection), with MM-DD-YY format.
  onChange: (value: string) => void;
  // Optional label text shown above the input (same style as other form labels in this app).
  label?: string;
  // If true, shows a red asterisk after the label.
  required?: boolean;
  // If true, shows "(optional)" after the label in lighter text.
  optional?: boolean;
  // Disables both the text input and the calendar button.
  disabled?: boolean;
  // Controls the keyboard "return" key label (e.g., "next", "done").
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
  // showPicker controls whether the native date picker is visible.
  // On Android this just renders the <DateTimePicker> (which shows its own native dialog).
  // On iOS this controls our custom Modal.
  const [showPicker, setShowPicker] = useState(false);

  // Show a red border + error message only when the user has typed a full date
  // (8 chars = MM-DD-YY) but it isn't valid. We don't show errors for partial input
  // so we don't annoy the user while they're still typing.
  const showError = value.length === 8 && !isValidDisplayDate(value);

  // handleTextChange runs on every keystroke — auto-formats the raw input.
  const handleTextChange = (raw: string) => {
    onChange(autoFormat(raw));
  };

  // handlePickerChange is called by the native picker when the user changes the selected date.
  // The behavior differs by platform:
  //   Android: fires once when the user taps "OK" or "Cancel" in the native dialog
  //   iOS:     fires continuously as the user scrolls the spinner wheel
  const handlePickerChange = (event: DateTimePickerEvent, date?: Date) => {
    if (Platform.OS === "android") {
      // On Android the picker dismisses itself — we just hide our flag.
      setShowPicker(false);
      // event.type === "set" means the user confirmed a selection (not "dismissed" = cancelled).
      if (event.type === "set" && date) {
        onChange(fromPickerDate(date));
      }
    } else {
      // iOS: update the value live as the spinner scrolls.
      // The user taps "Done" (a separate button we provide) to dismiss.
      if (date) {
        onChange(fromPickerDate(date));
      }
    }
  };

  return (
    <View>
      {/* Label row — same style used throughout the app for form field labels */}
      {label && (
        <Text className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
          {label}{" "}
          {/* Red asterisk for required fields */}
          {required && <Text className="text-red-500">*</Text>}
          {/* Lighter "(optional)" for optional fields */}
          {optional && (
            <Text className="text-gray-400 normal-case font-normal">
              (optional)
            </Text>
          )}
        </Text>
      )}

      {/* Input row: text field on the left, calendar icon button on the right */}
      <View
        className={`flex-row items-center border rounded-xl bg-gray-50 ${
          // Red border when the typed value is invalid; normal gray otherwise
          showError ? "border-red-400" : "border-gray-300"
        }`}
      >
        {/* Text input — auto-formats to MM-DD-YY as the user types */}
        <TextInput
          className="flex-1 px-4 py-3 text-base text-gray-900"
          placeholder="MM-DD-YY"
          value={value}
          onChangeText={handleTextChange}
          // "numeric" keyboard on mobile (digits only) — the auto-formatter strips non-digits
          keyboardType="numeric"
          // 8 = "MM-DD-YY", but maxLength on TextInput includes dashes so 8 is correct
          maxLength={8}
          editable={!disabled}
          returnKeyType={returnKeyType}
        />

        {/* Calendar icon — tapping opens the native date picker */}
        <TouchableOpacity
          className="px-3 py-3"
          onPress={() => setShowPicker(true)}
          disabled={disabled}
          // hitSlop enlarges the tap target without changing the visual size
          hitSlop={8}
          accessibilityLabel="Open date picker"
        >
          <Ionicons
            name="calendar-outline"
            size={20}
            // Dim the icon when the field is disabled
            color={disabled ? "#d1d5db" : "#6b7280"}
          />
        </TouchableOpacity>
      </View>

      {/* Inline error message — only visible when the full 8-char date is invalid */}
      {showError && (
        <Text className="text-red-500 text-xs mt-1 ml-1">
          Please enter a valid date (MM-DD-YY)
        </Text>
      )}

      {/* ── Native date picker ────────────────────────────────────────────────
          Android: DateTimePicker renders as a self-contained native dialog.
          We just mount it conditionally and it handles showing itself.
          iOS: DateTimePicker has no built-in dialog mode — we wrap it in a Modal
          with a backdrop and a "Done" button. */}

      {Platform.OS === "android" && showPicker && (
        <DateTimePicker
          value={toPickerDate(value)}
          mode="date"
          // "default" uses the Android system date picker dialog
          display="default"
          onChange={handlePickerChange}
        />
      )}

      {Platform.OS === "ios" && (
        // transparent: lets us control the background with our own View
        // animationType="slide": the sheet slides up from the bottom
        <Modal
          visible={showPicker}
          transparent
          animationType="slide"
          onRequestClose={() => setShowPicker(false)}
        >
          {/* Full-screen container — positions the sheet at the bottom */}
          <View className="flex-1">
            {/* Semi-transparent backdrop: tapping anywhere outside the sheet closes it */}
            <TouchableOpacity
              className="absolute inset-0 bg-black/40"
              activeOpacity={1}
              onPress={() => setShowPicker(false)}
            />

            {/* The bottom sheet itself */}
            <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl pb-8">
              {/* Header row: title on left, "Done" button on right */}
              <View className="flex-row items-center justify-between px-5 pt-4 pb-2 border-b border-gray-100">
                <Text className="text-gray-500 font-semibold">Select Date</Text>
                <TouchableOpacity onPress={() => setShowPicker(false)}>
                  <Text className="text-green-700 font-semibold text-base">
                    Done
                  </Text>
                </TouchableOpacity>
              </View>

              {/* "spinner" is the iOS scroll-wheel style date picker.
                  The height style is required — DateTimePicker on iOS needs an
                  explicit pixel height to render correctly in a flex layout.
                  We can't use NativeWind here because it's a native component. */}
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
