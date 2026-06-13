// components/RoundFormFields.tsx
// Shared round form UI: course picker, tee picker, no-tees chip, no-hole
// warning, nine-hole selector (18-hole courses only), and scoring format grid.
// Used by app/rounds/create.tsx and the schedule-round modal in app/events/[id].tsx
// so changes to these fields propagate to both surfaces automatically.
//
// Does NOT include CoursePickerModal — callers render it themselves because modal
// stacking order is context-dependent (the events screen nests it outside a Modal).

import { Text, View, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import type { PickedCourse } from "@/components/CoursePickerModal";
import { chunk } from "@/utils/array";
import { SCORING_FORMATS } from "@/utils/scoringFormats";

interface RoundFormFieldsProps {
  selectedCourse: PickedCourse | null;
  selectedTeeId: string | null;
  nineHoleSelection: "18" | "front" | "back";
  scoringFormat: string;
  // Las Vegas toggles — only rendered when scoringFormat is "las_vegas".
  vegasBirdieFlip: boolean;
  vegasScoringBasis: "gross" | "net";
  // Best Ball toggle — only rendered when scoringFormat is "best_ball".
  bestBallScoringBasis: "gross" | "net";
  isPending: boolean;
  onOpenCoursePicker: () => void;
  onClearCourse: () => void;
  onSelectTee: (id: string) => void;
  onChangeNineHoles: (val: "18" | "front" | "back") => void;
  onChangeScoringFormat: (val: string) => void;
  onChangeVegasBirdieFlip: (val: boolean) => void;
  onChangeVegasScoringBasis: (val: "gross" | "net") => void;
  onChangeBestBallScoringBasis: (val: "gross" | "net") => void;
}

export default function RoundFormFields({
  selectedCourse,
  selectedTeeId,
  nineHoleSelection,
  scoringFormat,
  vegasBirdieFlip,
  vegasScoringBasis,
  bestBallScoringBasis,
  isPending,
  onOpenCoursePicker,
  onClearCourse,
  onSelectTee,
  onChangeNineHoles,
  onChangeScoringFormat,
  onChangeVegasBirdieFlip,
  onChangeVegasScoringBasis,
  onChangeBestBallScoringBasis,
}: RoundFormFieldsProps) {
  const t = useTheme();

  return (
    <>
      {/* ── Course picker ──────────────────────────────────────────────────── */}
      <View className="mb-4">
        <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
          Course <Text className="text-red-500">*</Text>
        </Text>
        <TouchableOpacity
          className={`border rounded-xl px-4 py-3 flex-row items-center gap-3 ${t.borderInput} ${t.surfaceSunken}`}
          onPress={onOpenCoursePicker}
          disabled={isPending}
          activeOpacity={0.7}
        >
          <View className="flex-1">
            {selectedCourse ? (
              <>
                <Text className={`text-base ${t.textPrimary}`}>{selectedCourse.name}</Text>
                {!!(selectedCourse.city || selectedCourse.state) && (
                  <Text className={`text-xs mt-0.5 ${t.textTertiary}`}>
                    {[selectedCourse.city, selectedCourse.state].filter(Boolean).join(", ")}
                  </Text>
                )}
              </>
            ) : (
              <Text className={`text-base ${t.textTertiary}`}>Search for a course…</Text>
            )}
          </View>
          {selectedCourse ? (
            <TouchableOpacity onPress={onClearCourse} hitSlop={8} disabled={isPending}>
              <Ionicons name="close-circle" size={18} color={t.colors.tabBarInactive} />
            </TouchableOpacity>
          ) : (
            <Ionicons name="chevron-forward" size={16} color={t.colors.tabBarInactive} />
          )}
        </TouchableOpacity>
      </View>

      {/* ── Tee picker — only shown when the course has tees ──────────────── */}
      {selectedCourse && selectedCourse.tees.length > 0 && (
        <View className="mb-4">
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
            Tee <Text className="text-red-500">*</Text>
          </Text>
          <View className="gap-2">
            {chunk(selectedCourse.tees, 2).map((row, rowIdx) => (
              <View key={rowIdx} className="flex-row gap-2">
                {row.map((tee) => {
                  const selected = selectedTeeId === tee.id;
                  return (
                    <TouchableOpacity
                      key={tee.id}
                      className={`flex-1 rounded-xl py-2.5 px-2 items-center border ${
                        selected
                          ? `${t.primaryBg} border-transparent`
                          : `${t.surface} ${t.borderInput}`
                      }`}
                      onPress={() => onSelectTee(tee.id)}
                      disabled={isPending}
                    >
                      <Text className={`text-sm font-semibold ${selected ? "text-white" : t.textSecondary}`}>
                        {tee.name}
                      </Text>
                      <Text className={`text-xs mt-0.5 ${selected ? "text-white/80" : t.textTertiary}`}>
                        Par {tee.par} · Slope {tee.slope_rating} · {tee.course_rating}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Info chip when the course has no tees */}
      {selectedCourse && selectedCourse.tees.length === 0 && (
        <View className={`mb-4 flex-row items-center gap-2 rounded-xl px-3 py-2.5 border ${t.border}`}>
          <Ionicons name="information-circle-outline" size={16} color={t.colors.tabBarInactive} />
          <Text className={`text-xs flex-1 ${t.textTertiary}`}>
            No tees configured — a default tee will be created automatically.
          </Text>
        </View>
      )}

      {/* Warning when the course has no hole data */}
      {selectedCourse && !selectedCourse.has_holes && (
        <View className="mb-4 flex-row items-center gap-2 rounded-xl bg-amber-50 border border-amber-200 p-3">
          <Ionicons name="warning-outline" size={16} color="#d97706" />
          <Text className="text-xs text-amber-700 flex-1">
            This course has no hole data. Par and stroke index won{"'"}t be available on the scorecard.
          </Text>
        </View>
      )}

      {/* ── Nine-hole selector — 18-hole courses only ─────────────────────── */}
      {selectedCourse && selectedCourse.hole_count === 18 && (
        <View className="mb-4">
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
            Holes
          </Text>
          <View className="flex-row gap-2">
            {([
              { value: "18",    label: "Full 18" },
              { value: "front", label: "Front 9" },
              { value: "back",  label: "Back 9"  },
            ] as const).map((opt) => {
              const selected = nineHoleSelection === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  className={`flex-1 rounded-xl py-2.5 items-center border ${
                    selected
                      ? `${t.primaryBg} border-transparent`
                      : `${t.surface} ${t.borderInput}`
                  }`}
                  onPress={() => onChangeNineHoles(opt.value)}
                  disabled={isPending}
                >
                  <Text className={`text-sm font-semibold ${selected ? "text-white" : t.textSecondary}`}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* ── Scoring format picker — 2-column pill grid ────────────────────── */}
      <View className={scoringFormat === "las_vegas" || scoringFormat === "best_ball" ? "mb-4" : "mb-8"}>
        <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
          Scoring Format
        </Text>
        <View className="gap-2">
          {chunk(SCORING_FORMATS, 2).map((row, rowIdx) => (
            <View key={rowIdx} className="flex-row gap-2">
              {row.map((fmt) => {
                const selected = scoringFormat === fmt.value;
                return (
                  <TouchableOpacity
                    key={fmt.value}
                    className={`flex-1 rounded-xl py-3 items-center border ${
                      selected
                        ? `${t.primaryBg} border-transparent`
                        : `${t.surface} ${t.borderInput}`
                    }`}
                    onPress={() => onChangeScoringFormat(fmt.value)}
                    disabled={isPending}
                  >
                    <Text className={`text-sm font-semibold ${selected ? "text-white" : t.textSecondary}`}>
                      {fmt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ))}
        </View>
      </View>

      {/* ── Las Vegas options — only for a las_vegas round ────────────────── */}
      {scoringFormat === "las_vegas" && (
        <View className="mb-8">
          {/* Birdie flip toggle */}
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
            Birdie Flip
          </Text>
          <View className="flex-row gap-2 mb-4">
            {([
              { value: true,  label: "On"  },
              { value: false, label: "Off" },
            ] as const).map((opt) => {
              const selected = vegasBirdieFlip === opt.value;
              return (
                <TouchableOpacity
                  key={String(opt.value)}
                  className={`flex-1 rounded-xl py-2.5 items-center border ${
                    selected ? `${t.primaryBg} border-transparent` : `${t.surface} ${t.borderInput}`
                  }`}
                  onPress={() => onChangeVegasBirdieFlip(opt.value)}
                  disabled={isPending}
                >
                  <Text className={`text-sm font-semibold ${selected ? "text-white" : t.textSecondary}`}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text className={`text-xs mb-4 ${t.textTertiary}`}>
            When a team birdies, the opponents{"'"} combined number flips high-digit-first.
          </Text>

          {/* Scoring basis toggle */}
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
            Scoring Basis
          </Text>
          <View className="flex-row gap-2">
            {([
              { value: "gross", label: "Gross" },
              { value: "net",   label: "Net"   },
            ] as const).map((opt) => {
              const selected = vegasScoringBasis === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  className={`flex-1 rounded-xl py-2.5 items-center border ${
                    selected ? `${t.primaryBg} border-transparent` : `${t.surface} ${t.borderInput}`
                  }`}
                  onPress={() => onChangeVegasScoringBasis(opt.value)}
                  disabled={isPending}
                >
                  <Text className={`text-sm font-semibold ${selected ? "text-white" : t.textSecondary}`}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* ── Best Ball options — only for a best_ball round ────────────────── */}
      {scoringFormat === "best_ball" && (
        <View className="mb-8">
          <Text className={`text-xs font-semibold uppercase tracking-widest mb-2 ${t.textTertiary}`}>
            Scoring Basis
          </Text>
          <View className="flex-row gap-2">
            {([
              { value: "gross", label: "Gross" },
              { value: "net",   label: "Net"   },
            ] as const).map((opt) => {
              const selected = bestBallScoringBasis === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  className={`flex-1 rounded-xl py-2.5 items-center border ${
                    selected ? `${t.primaryBg} border-transparent` : `${t.surface} ${t.borderInput}`
                  }`}
                  onPress={() => onChangeBestBallScoringBasis(opt.value)}
                  disabled={isPending}
                >
                  <Text className={`text-sm font-semibold ${selected ? "text-white" : t.textSecondary}`}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text className={`text-xs mt-3 ${t.textTertiary}`}>
            Each team{"'"}s lowest score on a hole counts. Assign teams from the round screen
            once players have joined.
          </Text>
        </View>
      )}
    </>
  );
}
