// components/TeeForm.tsx
// Modal sheet for creating or editing a tee set on a course.
// Used in app/courses/[id].tsx for both "+ Add Tee" (create) and the tee edit action.
//
// Fields: name, course rating, slope rating, par.
// Gender is intentionally omitted — tee names (Blue, White, Red) are the identifier.
// The backend defaults gender to "unisex" when not supplied.

import { useState, useEffect } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useAuth } from "@/hooks/useAuth";
import { useTheme } from "@/hooks/useTheme";
import { API_URL } from "@/constants/api";
import ModalHeader from "@/components/ModalHeader";
import type { TeeDetail } from "@/types/courses";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeeFormProps {
  visible: boolean;
  onClose: () => void;
  courseId: string;
  // existing is provided when editing; null/undefined means create mode.
  existing?: TeeDetail | null;
  // onSaved is called after a successful create or update so the parent can refetch.
  onSaved: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TeeForm({
  visible,
  onClose,
  courseId,
  existing,
  onSaved,
}: TeeFormProps) {
  const { getToken } = useAuth();
  const t = useTheme();

  const [name,         setName]         = useState("");
  const [courseRating, setCourseRating] = useState("");
  const [slopeRating,  setSlopeRating]  = useState("");
  const [par,          setPar]          = useState("");
  const [saving,       setSaving]       = useState(false);

  const isEdit = !!existing;

  // Pre-fill form when editing.
  useEffect(() => {
    if (visible && existing) {
      setName(existing.name);
      setCourseRating(String(existing.course_rating));
      setSlopeRating(String(existing.slope_rating));
      setPar(String(existing.par));
    } else if (visible) {
      setName("");
      setCourseRating("");
      setSlopeRating("");
      setPar("");
    }
  }, [visible, existing]);

  const canSubmit =
    name.trim() &&
    courseRating.trim() &&
    slopeRating.trim() &&
    par.trim() &&
    !saving;

  const handleSubmit = async () => {
    const ratingNum = parseFloat(courseRating);
    const slopeNum  = parseInt(slopeRating, 10);
    const parNum    = parseInt(par, 10);

    if (isNaN(ratingNum) || ratingNum <= 0) {
      Alert.alert("Invalid", "Course rating must be a positive number.");
      return;
    }
    if (isNaN(slopeNum) || slopeNum < 55 || slopeNum > 155) {
      Alert.alert("Invalid", "Slope rating must be between 55 and 155.");
      return;
    }
    if (isNaN(parNum) || parNum <= 0) {
      Alert.alert("Invalid", "Par must be a positive number.");
      return;
    }

    setSaving(true);
    try {
      const token = await getToken();
      const url = isEdit
        ? `${API_URL}/api/v1/courses/${courseId}/tees/${existing!.id}`
        : `${API_URL}/api/v1/courses/${courseId}/tees`;
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: {
          Authorization:  `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name:          name.trim(),
          course_rating: ratingNum,
          slope_rating:  slopeNum,
          par:           parNum,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        Alert.alert("Error", (body as { error?: string }).error ?? "Could not save tee.");
        return;
      }

      onSaved();
      onClose();
    } catch {
      Alert.alert("Error", "Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className={`flex-1 ${t.surface} px-5 pt-8`}>
        <ModalHeader
          title={isEdit ? "Edit Tee" : "Add Tee"}
          onClose={onClose}
          disabled={saving}
        />

        <View className="mt-6 gap-4">
          {/* Name */}
          <View>
            <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
              Name <Text className="text-red-500">*</Text>
            </Text>
            <TextInput
              className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
              placeholder='e.g. "Blue"'
              placeholderTextColor={t.colors.tabBarInactive}
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              editable={!saving}
            />
          </View>

          {/* Course Rating */}
          <View>
            <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
              Course Rating <Text className="text-red-500">*</Text>
            </Text>
            <TextInput
              className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
              placeholder="e.g. 72.4"
              placeholderTextColor={t.colors.tabBarInactive}
              value={courseRating}
              onChangeText={setCourseRating}
              keyboardType="decimal-pad"
              editable={!saving}
            />
          </View>

          {/* Slope Rating */}
          <View>
            <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
              Slope Rating (55–155) <Text className="text-red-500">*</Text>
            </Text>
            <TextInput
              className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
              placeholder="e.g. 130"
              placeholderTextColor={t.colors.tabBarInactive}
              value={slopeRating}
              onChangeText={setSlopeRating}
              keyboardType="number-pad"
              maxLength={3}
              editable={!saving}
            />
          </View>

          {/* Par */}
          <View>
            <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
              Par <Text className="text-red-500">*</Text>
            </Text>
            <TextInput
              className={`border rounded-xl px-4 py-3 text-base ${t.borderInput} ${t.surfaceSunken} ${t.textPrimary}`}
              placeholder="e.g. 72"
              placeholderTextColor={t.colors.tabBarInactive}
              value={par}
              onChangeText={setPar}
              keyboardType="number-pad"
              maxLength={2}
              editable={!saving}
            />
          </View>

          {/* Submit */}
          <TouchableOpacity
            className={`rounded-xl py-3.5 items-center mt-2 ${canSubmit ? "bg-green-700" : "bg-green-700/40"}`}
            onPress={handleSubmit}
            disabled={!canSubmit}
          >
            {saving ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-white font-semibold text-base">
                {isEdit ? "Save Changes" : "Add Tee"}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
