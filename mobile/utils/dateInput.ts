// utils/dateInput.ts
// Pure date helpers shared by the native and web DateInput components.
//
// Dates are held in form state as "MM-DD-YY"; the backend uses "YYYY-MM-DD". These
// functions convert between the two and validate/auto-format typed input. Extracted
// from the DateInput components (which are excluded from coverage) so the logic is
// unit-tested and lives in one place — DateInput.tsx and DateInput.web.tsx both
// import from here and re-export apiToDisplay/displayToApi for existing call sites.
// No React/RN imports — keep this pure.

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

// isValidDisplayDate: returns false for partial input (< 8 chars) so errors
// don't show while the user is still typing.
export function isValidDisplayDate(value: string): boolean {
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
export function autoFormat(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 6);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}
