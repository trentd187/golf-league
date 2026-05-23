// components/ScoreHistoryChart.tsx
// Score-to-par history line chart with hole-count and gross/net filter toggles.
// Accepts pre-computed ScorePoint[] from buildScoreHistory() and owns its own
// filter state so the parent (stats.tsx) stays thin.

import { useState, useMemo } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import Svg, { Path, Line, Circle, Text as SvgText } from "react-native-svg";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import type { ScorePoint } from "@/utils/stats";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAD_LEFT   = 32;
const PAD_RIGHT  = 10;
const PAD_TOP    = 12;
const PAD_BOTTOM = 26;
const VIEW_W     = 360;
const VIEW_H     = 200;
const CHART_W    = VIEW_W - PAD_LEFT - PAD_RIGHT;
const CHART_H    = VIEW_H - PAD_TOP - PAD_BOTTOM;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// dotColor maps a score-to-par value to a categorical color.
// Colors encode meaning, so they are hardcoded rather than using theme tokens.
function dotColor(v: number): string {
  if (v <= -1) return "#16a34a"; // green-600: under par
  if (v === 0) return "#6b7280"; // gray-500: even par
  if (v <= 5)  return "#f59e0b"; // amber-500: 1–5 over
  return "#ef4444";              // red-500: 6+ over
}

// formatDate converts "YYYY-MM-DD" to "MMM D" for x-axis labels.
function formatDate(s: string): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const parts = s.split("-");
  return `${months[parseInt(parts[1], 10) - 1]} ${parseInt(parts[2], 10)}`;
}

// formatYLabel formats an integer score-to-par value for y-axis labels.
function formatYLabel(v: number): string {
  if (v === 0) return "E";
  return v > 0 ? `+${v}` : `${v}`;
}

// ─── Chart internals ──────────────────────────────────────────────────────────

type HoleFilter = "all" | "9" | "18";
type ScoreType  = "gross" | "net";

function ChartSvg({
  visible,
  scoreType,
}: {
  visible: ScorePoint[];
  scoreType: ScoreType;
}) {
  const t = useTheme();
  const N = visible.length;

  // Resolve the numeric value for each point based on scoreType.
  // In net mode, fall back to scoreToPar when netScoreToPar is null so the
  // dot still renders (at gross position) with a translucent fill.
  const values = visible.map((p) =>
    scoreType === "net" && p.netScoreToPar != null ? p.netScoreToPar : p.scoreToPar
  );

  // Y-range must contain 0 (par line) plus the full value spread.
  const rawMin = Math.min(...values, 0);
  const rawMax = Math.max(...values, 0);
  const yMin = rawMin - 2;
  const yMax = rawMax + 2;
  const ySpan = yMax - yMin;

  function xToSvg(i: number): number {
    return PAD_LEFT + (N > 1 ? (i / (N - 1)) * CHART_W : CHART_W / 2);
  }

  function yToSvg(v: number): number {
    return PAD_TOP + CHART_H - ((v - yMin) / ySpan) * CHART_H;
  }

  // Build the connecting line path, inserting M for gaps where the net value
  // is unavailable in net mode.
  const linePath = useMemo(() => {
    let d = "";
    let inSeg = false;
    for (let i = 0; i < N; i++) {
      const p = visible[i];
      const skip = scoreType === "net" && p.netScoreToPar == null;
      if (skip) { inSeg = false; continue; }
      const v = scoreType === "net" ? p.netScoreToPar! : p.scoreToPar;
      const x = xToSvg(i).toFixed(1);
      const y = yToSvg(v).toFixed(1);
      d += inSeg ? `L ${x} ${y} ` : `M ${x} ${y} `;
      inSeg = true;
    }
    return d.trim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, scoreType, yMin, yMax]);

  // X-axis: pick up to 5 evenly-spaced label indices.
  const xLabelIndices = useMemo<number[]>(() => {
    if (N === 0) return [];
    if (N <= 5)  return Array.from({ length: N }, (_, i) => i);
    const step = (N - 1) / 4;
    return Array.from({ length: 5 }, (_, i) => Math.round(i * step));
  }, [N]);

  // Y-axis: at most 4 labels — yMin, 0 (par), yMax, midpoint if range is large.
  const yLabelValues = useMemo<number[]>(() => {
    const set = new Set<number>([Math.ceil(yMin), 0, Math.floor(yMax)]);
    if (yMax - yMin > 6) set.add(Math.round((yMin + yMax) / 2));
    return [...set].sort((a, b) => a - b);
  }, [yMin, yMax]);

  const parY = yToSvg(0).toFixed(1);

  return (
    <Svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" height={VIEW_H}>
      {/* Par line (y=0), dashed green */}
      <Line
        x1={PAD_LEFT}
        y1={parY}
        x2={VIEW_W - PAD_RIGHT}
        y2={parY}
        stroke="#15803d"
        strokeWidth={1}
        strokeDasharray="4 3"
      />
      {/* "E" label on the par line */}
      <SvgText
        x={PAD_LEFT - 4}
        y={(parseFloat(parY) + 4).toFixed(1)}
        textAnchor="end"
        fontSize={10}
        fontWeight="600"
        fill="#15803d"
      >
        E
      </SvgText>

      {/* Y-axis labels (skip 0 — already shown as "E" above) */}
      {yLabelValues
        .filter((v) => v !== 0)
        .map((v) => (
          <SvgText
            key={`yl-${v}`}
            x={PAD_LEFT - 4}
            y={(yToSvg(v) + 4).toFixed(1)}
            textAnchor="end"
            fontSize={9}
            fill={t.colors.tabBarInactive}
          >
            {formatYLabel(v)}
          </SvgText>
        ))}

      {/* Connecting line */}
      {linePath.length > 0 && (
        <Path
          d={linePath}
          stroke={t.colors.tabBarInactive}
          strokeWidth={1.5}
          fill="none"
        />
      )}

      {/* Dots */}
      {visible.map((p, i) => {
        const isNetNull  = scoreType === "net" && p.netScoreToPar == null;
        const val        = isNetNull ? p.scoreToPar : values[i];
        const cx         = xToSvg(i).toFixed(1);
        const cy         = yToSvg(val).toFixed(1);
        const r          = p.holeCount === 9 ? 3 : 4;
        const color      = dotColor(val);
        // 9-hole dots in "all" view and null-net dots are semi-transparent.
        const opacity    = isNetNull ? 0.35 : 1;

        return (
          <Circle
            key={`dot-${p.date}-${i}`}
            cx={cx}
            cy={cy}
            r={r}
            fill={color}
            fillOpacity={opacity}
          />
        );
      })}

      {/* X-axis date labels */}
      {xLabelIndices.map((i) => (
        <SvgText
          key={`xl-${i}`}
          x={xToSvg(i).toFixed(1)}
          y={(PAD_TOP + CHART_H + 16).toFixed(1)}
          textAnchor="middle"
          fontSize={9}
          fill={t.colors.tabBarInactive}
        >
          {formatDate(visible[i].date)}
        </SvgText>
      ))}
    </Svg>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export default function ScoreHistoryChart({ points }: { points: ScorePoint[] }) {
  const t = useTheme();

  const [holeFilter, setHoleFilter] = useState<HoleFilter>("all");
  const [scoreType,  setScoreType]  = useState<ScoreType>("gross");

  const hasNine    = points.some((p) => p.holeCount === 9);
  const hasEighteen = points.some((p) => p.holeCount === 18);
  const hasNet     = points.some((p) => p.netScoreToPar !== null);

  // When only one hole type exists, the filter is irrelevant — don't show it.
  const showHoleFilter  = hasNine && hasEighteen;
  const showScoreToggle = hasNet;
  const showFilterRow   = showHoleFilter || showScoreToggle;

  const visible = useMemo(
    () =>
      holeFilter === "all"
        ? points
        : points.filter((p) => p.holeCount === (holeFilter === "9" ? 9 : 18)),
    [points, holeFilter]
  );

  // Pill style helpers.
  function pillActive(active: boolean) {
    return active
      ? "bg-green-700 rounded-full px-3 py-1.5"
      : `${t.surface} border ${t.border} rounded-full px-3 py-1.5`;
  }
  function pillText(active: boolean) {
    return active ? "text-white text-xs font-semibold" : `${t.textPrimary} text-xs font-semibold`;
  }

  if (points.length === 0) {
    return (
      <View
        className={`${t.surface} rounded-2xl border ${t.border} items-center justify-center mb-4 gap-2`}
        style={{ height: 180 }}
      >
        <Ionicons name="trending-up-outline" size={36} color={t.colors.tabBarInactive} />
        <Text className={`text-sm ${t.textSecondary}`}>No rounds to display</Text>
      </View>
    );
  }

  return (
    <View className={`${t.surface} rounded-2xl border ${t.border} mb-4 overflow-hidden`}>
      {showFilterRow && (
        <View className="flex-row items-center justify-between px-3 pt-3 gap-2">
          {/* Hole count filter (left side) */}
          {showHoleFilter ? (
            <View className="flex-row gap-1.5">
              {(["all", "18", "9"] as HoleFilter[]).map((f) => (
                <TouchableOpacity
                  key={f}
                  className={pillActive(holeFilter === f)}
                  onPress={() => setHoleFilter(f)}
                  activeOpacity={0.7}
                >
                  <Text className={pillText(holeFilter === f)}>
                    {f === "all" ? "All" : `${f} Holes`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <View />
          )}

          {/* Gross / Net toggle (right side) */}
          {showScoreToggle && (
            <View className="flex-row gap-1.5">
              {(["gross", "net"] as ScoreType[]).map((s) => (
                <TouchableOpacity
                  key={s}
                  className={pillActive(scoreType === s)}
                  onPress={() => setScoreType(s)}
                  activeOpacity={0.7}
                >
                  <Text className={pillText(scoreType === s)}>
                    {s === "gross" ? "Gross" : "Net"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}

      {visible.length === 0 ? (
        <View className="items-center justify-center gap-2 py-10">
          <Ionicons name="trending-up-outline" size={36} color={t.colors.tabBarInactive} />
          <Text className={`text-sm ${t.textSecondary}`}>
            No {holeFilter === "9" ? "9-hole" : "18-hole"} rounds in this period
          </Text>
        </View>
      ) : (
        <ChartSvg visible={visible} scoreType={scoreType} />
      )}
    </View>
  );
}
