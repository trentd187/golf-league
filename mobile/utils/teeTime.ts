// utils/teeTime.ts
// Pure helpers for converting tee times between the three forms used in the app:
//   - internal storage / HTML <input type="time">: "HH:MM" 24-hour (e.g. "07:30")
//   - the native DateTimePicker: a JS Date (only the time component matters)
//   - display / the backend's group.tee_time field: "h:mm AM/PM" (e.g. "7:30 AM")
//
// Extracted from the event and round detail screens so the conversion logic is
// unit-tested and shared by the new TimeInput component (screens are excluded from
// coverage; utils/** is collected). No React/RN imports — keep this pure.

// teeTimeToDate: "HH:MM" → JS Date (today's date, only time matters). Empty → now.
export function teeTimeToDate(hhmm: string): Date {
  const d = new Date();
  if (!hhmm) return d;
  const [h, m] = hhmm.split(":").map(Number);
  if (!isNaN(h) && !isNaN(m)) d.setHours(h, m, 0, 0);
  return d;
}

// dateToTeeTime: Date → "HH:MM". padStart zero-pads single digits (7 → "07").
export function dateToTeeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// formatTeeTime: "HH:MM" → "h:mm AM/PM" for display. e.g. "07:30" → "7:30 AM".
// Returns "" for empty input and echoes back unparseable input unchanged.
export function formatTeeTime(hhmm: string): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return hhmm;
  const ampm = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 || 12; // 0 → 12 (midnight), 12 → 12 (noon)
  return `${hour12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// parseFormattedTeeTime: "h:mm AM/PM" → "HH:MM" 24-hour. Returns "" when the input
// is empty or doesn't match the expected display format (the inverse of formatTeeTime).
// The backend sends group.tee_time pre-formatted as "h:mm AM/PM"; the picker needs "HH:MM".
export function parseFormattedTeeTime(formatted: string | null | undefined): string {
  if (!formatted) return "";
  const match = formatted.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return "";
  let h = parseInt(match[1], 10);
  const m = match[2];
  const ampm = match[3].toUpperCase();
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${m}`;
}
