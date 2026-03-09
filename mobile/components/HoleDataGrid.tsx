// components/HoleDataGrid.tsx
// Displays and (optionally) edits the 18-hole scorecard data for a single tee set.
//
// Display mode (all users): read-only table of hole #, par, stroke index (SI), yardage.
// Edit mode (admin/manager): each cell becomes a TextInput; "Save Holes" triggers a
// bulk PUT to replace all holes atomically.
//
// The component is always given the current holes array (may be empty) and an
// editable flag. Calling the onSaved callback tells the parent to refetch.

import { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useAuth } from "@clerk/clerk-expo";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import type { HoleRow } from "@/types/courses";

// ─── Types ────────────────────────────────────────────────────────────────────

interface HoleDataGridProps {
  courseId: string;
  teeId: string;
  // holes may be an empty array when no data has been entered yet.
  holes: HoleRow[];
  // editable: true for admin/manager users; false for players (read-only).
  editable: boolean;
  // onSaved is called after a successful save so the parent can refetch course data.
  onSaved?: () => void;
}

// EditRow mirrors HoleRow but uses strings for TextInput compatibility.
// Blank strings represent missing / not-yet-entered values.
interface EditRow {
  par: string;
  strokeIndex: string;
  yardage: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// buildInitialEditRows creates 18 blank rows, pre-filling from existing hole data.
function buildInitialEditRows(holes: HoleRow[]): EditRow[] {
  return Array.from({ length: 18 }, (_, i) => {
    const existing = holes.find((h) => h.hole_number === i + 1);
    return {
      par:         existing ? String(existing.par)          : "",
      strokeIndex: existing ? String(existing.stroke_index) : "",
      yardage:     existing?.yardage != null ? String(existing.yardage) : "",
    };
  });
}

// isEditRowsValid checks that all 18 rows have par + stroke index filled in,
// stroke indexes are 1–18 with no duplicates, and pars are 3–6.
function isEditRowsValid(rows: EditRow[]): string | null {
  const siSet = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const hole = i + 1;
    const par = parseInt(rows[i].par, 10);
    const si  = parseInt(rows[i].strokeIndex, 10);

    if (!rows[i].par.trim() || isNaN(par)) {
      return `Hole ${hole}: par is required`;
    }
    if (par < 3 || par > 6) {
      return `Hole ${hole}: par must be between 3 and 6`;
    }
    if (!rows[i].strokeIndex.trim() || isNaN(si)) {
      return `Hole ${hole}: stroke index is required`;
    }
    if (si < 1 || si > 18) {
      return `Hole ${hole}: stroke index must be 1–18`;
    }
    if (siSet.has(si)) {
      return `Stroke index ${si} is used more than once`;
    }
    siSet.add(si);
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function HoleDataGrid({
  courseId,
  teeId,
  holes,
  editable,
  onSaved,
}: HoleDataGridProps) {
  const { getToken } = useAuth();
  const t = useTheme();

  const [editing, setEditing]     = useState(false);
  const [saving, setSaving]       = useState(false);
  const [editRows, setEditRows]   = useState<EditRow[]>([]);

  // enterEdit initialises the edit rows from the current holes prop.
  const enterEdit = useCallback(() => {
    setEditRows(buildInitialEditRows(holes));
    setEditing(true);
  }, [holes]);

  // updateCell updates one field in one row without mutating state directly.
  const updateCell = useCallback(
    (rowIndex: number, field: keyof EditRow, value: string) => {
      setEditRows((prev) => {
        const next = [...prev];
        next[rowIndex] = { ...next[rowIndex], [field]: value };
        return next;
      });
    },
    [],
  );

  // saveHoles validates and PUTs all 18 holes to the backend.
  const saveHoles = async () => {
    const validationError = isEditRowsValid(editRows);
    if (validationError) {
      Alert.alert("Invalid data", validationError);
      return;
    }

    setSaving(true);
    try {
      const token = await getToken();
      const payload = editRows.map((row, i) => ({
        hole_number:  i + 1,
        par:          parseInt(row.par, 10),
        stroke_index: parseInt(row.strokeIndex, 10),
        yardage:      row.yardage.trim() ? parseInt(row.yardage, 10) : null,
      }));

      const res = await fetch(
        `${API_URL}/api/v1/courses/${courseId}/tees/${teeId}/holes`,
        {
          method:  "PUT",
          headers: {
            Authorization:  `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ holes: payload }),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        Alert.alert("Save failed", (body as { error?: string }).error ?? "Could not save holes.");
        return;
      }

      setEditing(false);
      onSaved?.();
    } catch {
      Alert.alert("Save failed", "Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  // ── Column widths (consistent between header and data rows) ──────────────
  // Using fixed px widths keeps the grid aligned when TextInputs are active.
  const colHole = "w-8";
  const colPar  = "w-12";
  const colSI   = "w-12";
  const colYard = "flex-1"; // yardage fills remaining space

  // ── Header row ────────────────────────────────────────────────────────────
  const header = (
    <View className={`flex-row py-1.5 border-b ${t.divider}`}>
      <Text className={`${colHole} text-xs font-semibold text-center ${t.textTertiary}`}>#</Text>
      <Text className={`${colPar}  text-xs font-semibold text-center ${t.textTertiary}`}>Par</Text>
      <Text className={`${colSI}   text-xs font-semibold text-center ${t.textTertiary}`}>SI</Text>
      <Text className={`${colYard} text-xs font-semibold text-center ${t.textTertiary}`}>Yards</Text>
    </View>
  );

  // ── Display mode ──────────────────────────────────────────────────────────
  if (!editing) {
    // Compute totals for the footer row (only from filled holes).
    const totalPar   = holes.reduce((sum, h) => sum + h.par, 0);
    const totalYards = holes.reduce((sum, h) => sum + (h.yardage ?? 0), 0);
    const hasYardage = holes.some((h) => h.yardage != null);

    return (
      <View>
        {header}
        {Array.from({ length: 18 }, (_, i) => {
          const hole = holes.find((h) => h.hole_number === i + 1);
          return (
            <View
              key={i}
              className={`flex-row py-2 border-b ${t.divider} ${i % 2 === 0 ? "" : t.surfaceSunken}`}
            >
              <Text className={`${colHole} text-sm text-center ${t.textTertiary}`}>{i + 1}</Text>
              <Text className={`${colPar}  text-sm text-center ${t.textPrimary}`}>
                {hole ? String(hole.par) : "—"}
              </Text>
              <Text className={`${colSI}   text-sm text-center ${t.textSecondary}`}>
                {hole ? String(hole.stroke_index) : "—"}
              </Text>
              <Text className={`${colYard} text-sm text-center ${t.textSecondary}`}>
                {hole?.yardage != null ? String(hole.yardage) : "—"}
              </Text>
            </View>
          );
        })}
        {/* Totals row */}
        {holes.length > 0 && (
          <View className={`flex-row py-2 border-t ${t.divider}`}>
            <Text className={`${colHole} text-xs font-semibold text-center ${t.textTertiary}`}>Σ</Text>
            <Text className={`${colPar}  text-xs font-semibold text-center ${t.textPrimary}`}>{totalPar}</Text>
            <Text className={`${colSI}   text-xs text-center ${t.textTertiary}`}></Text>
            <Text className={`${colYard} text-xs font-semibold text-center ${t.textSecondary}`}>
              {hasYardage ? totalYards : ""}
            </Text>
          </View>
        )}
        {/* Empty state */}
        {holes.length === 0 && (
          <Text className={`text-sm text-center py-4 ${t.textTertiary}`}>
            No hole data entered yet.
          </Text>
        )}
        {/* Edit Holes button — only for admin/manager */}
        {editable && (
          <TouchableOpacity
            className={`mt-3 flex-row items-center justify-center gap-2 border rounded-xl py-2.5 ${t.borderInput}`}
            onPress={enterEdit}
          >
            <Ionicons name="create-outline" size={16} color={t.colors.tabBarActive} />
            {/* eslint-disable-next-line react-native/no-inline-styles */}
            <Text className="text-sm font-semibold" style={{ color: t.colors.tabBarActive }}>
              {holes.length === 0 ? "Enter Hole Data" : "Edit Holes"}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // ── Edit mode ─────────────────────────────────────────────────────────────
  // allFilled is true when every row has par + SI entered — enables the Save button.
  const allFilled = editRows.every((r) => r.par.trim() && r.strokeIndex.trim());

  return (
    <View>
      {header}
      {editRows.map((row, i) => (
        <View key={i} className={`flex-row items-center py-1.5 border-b ${t.divider}`}>
          <Text className={`${colHole} text-sm text-center ${t.textTertiary}`}>{i + 1}</Text>

          {/* Par */}
          <View className={`${colPar} px-1`}>
            <TextInput
              className={`text-sm text-center rounded-lg px-1 py-1 border ${t.textPrimary} ${t.borderInput} ${t.surfaceSunken}`}
              keyboardType="number-pad"
              maxLength={1}
              value={row.par}
              onChangeText={(v) => updateCell(i, "par", v)}
              placeholderTextColor={t.colors.tabBarInactive}
              placeholder="—"
              editable={!saving}
            />
          </View>

          {/* Stroke index */}
          <View className={`${colSI} px-1`}>
            <TextInput
              className={`text-sm text-center rounded-lg px-1 py-1 border ${t.textPrimary} ${t.borderInput} ${t.surfaceSunken}`}
              keyboardType="number-pad"
              maxLength={2}
              value={row.strokeIndex}
              onChangeText={(v) => updateCell(i, "strokeIndex", v)}
              placeholderTextColor={t.colors.tabBarInactive}
              placeholder="—"
              editable={!saving}
            />
          </View>

          {/* Yardage (optional) */}
          <View className={`${colYard} px-1`}>
            <TextInput
              className={`text-sm text-center rounded-lg px-1 py-1 border ${t.textPrimary} ${t.borderInput} ${t.surfaceSunken}`}
              keyboardType="number-pad"
              maxLength={4}
              value={row.yardage}
              onChangeText={(v) => updateCell(i, "yardage", v)}
              placeholderTextColor={t.colors.tabBarInactive}
              placeholder="—"
              editable={!saving}
            />
          </View>
        </View>
      ))}

      {/* Edit actions */}
      <View className="flex-row gap-3 mt-3">
        <TouchableOpacity
          className={`flex-1 rounded-xl py-3 items-center border ${t.borderInput}`}
          onPress={() => setEditing(false)}
          disabled={saving}
        >
          <Text className={`text-sm font-semibold ${t.textSecondary}`}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          className={`flex-1 rounded-xl py-3 items-center ${allFilled && !saving ? "bg-green-700" : "bg-green-700/40"}`}
          onPress={saveHoles}
          disabled={!allFilled || saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Text className="text-sm font-semibold text-white">Save Holes</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}
