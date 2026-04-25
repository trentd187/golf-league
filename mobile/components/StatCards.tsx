// components/StatCards.tsx
// Shared stat display cards used by the personal Stats screen and public user profiles.
//
// Exports:
//   ScoringCard       — avg/low/high, par averages, scoring distribution donut
//   DirectionalMissCard — FIR or GIR compass with miss-direction breakdown
//   PuttingCard       — avg putts / round, putt distribution donut, made-putt distances

import { View, Text } from "react-native";
import Svg, { Path, Line, Text as SvgText } from "react-native-svg";
import { useTheme } from "@/hooks/useTheme";

// ─── ScoringCard ──────────────────────────────────────────────────────────────

// ScoringCard renders the Scoring section: avg/low/high summary, par-type averages,
// and a scoring distribution donut chart with SVG spoke labels.
// When lowScore/highScore are omitted (single-round view) only one centered "Score"
// column is rendered instead of three.
export function ScoringCard({
  avgGrossScore, lowScore, highScore,
  avgPar3, avgPar4, avgPar5,
  birdiesOrBetter, pars, bogeys, doublesPlus,
}: Readonly<{
  avgGrossScore: number | null;
  lowScore?: number | null;
  highScore?: number | null;
  avgPar3: number | null;
  avgPar4: number | null;
  avgPar5: number | null;
  birdiesOrBetter: number;
  pars: number;
  bogeys: number;
  doublesPlus: number;
}>) {
  const t = useTheme();

  const CX = 150, CY = 90, R = 55, IR = 32;
  const SPOKE_R   = 74;
  const ELBOW_LEN = 14;

  // Categorical colors — not theme tokens; color encodes the scoring outcome.
  const allSlices = [
    { value: birdiesOrBetter, color: "#16a34a", label: "Birdie+" },
    { value: pars,             color: "#3b82f6", label: "Par"     },
    { value: bogeys,           color: "#f59e0b", label: "Bogey"   },
    { value: doublesPlus,      color: "#ef4444", label: "Double+" },
  ];
  const total  = allSlices.reduce((s, x) => s + x.value, 0);
  const slices = allSlices.filter((s) => s.value > 0);

  function toXY(angle: number, radius: number) {
    return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
  }

  // Donut arc path; sweep clamped just below 2π to avoid degenerate full-circle edge.
  function arcPath(startAngle: number, sweep: number): string {
    const sw = Math.min(sweep, 2 * Math.PI - 0.001);
    const ea = startAngle + sw;
    const os = toXY(startAngle, R);
    const oe = toXY(ea, R);
    const is = toXY(startAngle, IR);
    const ie = toXY(ea, IR);
    const lg = sw > Math.PI ? 1 : 0;
    return [
      `M ${os.x.toFixed(2)} ${os.y.toFixed(2)}`,
      `A ${R} ${R} 0 ${lg} 1 ${oe.x.toFixed(2)} ${oe.y.toFixed(2)}`,
      `L ${ie.x.toFixed(2)} ${ie.y.toFixed(2)}`,
      `A ${IR} ${IR} 0 ${lg} 0 ${is.x.toFixed(2)} ${is.y.toFixed(2)}`,
      "Z",
    ].join(" ");
  }

  let angle = -Math.PI / 2;
  const paths = slices.map((s) => {
    const sweep     = (s.value / total) * 2 * Math.PI;
    const midAngle  = angle + sweep / 2;
    const d         = arcPath(angle, sweep);
    angle += sweep;

    const spokeEnd     = toXY(midAngle, SPOKE_R);
    const isRight      = Math.cos(midAngle) >= 0;
    const elbowX       = spokeEnd.x + (isRight ? ELBOW_LEN : -ELBOW_LEN);
    const textCenterX  = elbowX + (isRight ? 24 : -24);
    const pct          = Math.round((s.value / total) * 100);
    const spokeStart   = toXY(midAngle, R);
    return { ...s, d, spokeStart, spokeEnd, elbowX, textCenterX, pct, midY: spokeEnd.y };
  });

  const parItems = [
    { label: "Par 3 Avg", value: avgPar3 },
    { label: "Par 4 Avg", value: avgPar4 },
    { label: "Par 5 Avg", value: avgPar5 },
  ];

  return (
    <View className={`${t.surface} rounded-2xl border ${t.border} p-4 mb-3`}>
      <Text className={`text-sm font-bold uppercase tracking-widest ${t.textTertiary} mb-3`}>
        Scoring
      </Text>

      {/* Row 1: Avg | Low | High — or just Score for a single round */}
      <View className={`flex-row border-b ${t.divider} pb-3 mb-3`}>
        <View className="flex-1 items-center">
          <Text className={`text-2xl font-bold ${t.textPrimary}`}>
            {avgGrossScore === null ? "—" : avgGrossScore.toFixed(1)}
          </Text>
          <Text className={`text-xs font-semibold uppercase tracking-widest mt-0.5 ${t.textTertiary}`}>
            {lowScore === undefined ? "Score" : "18-Hole Avg"}
          </Text>
        </View>
        {lowScore !== undefined && highScore !== undefined && (
          <>
            <View className={`w-px ${t.border} border-l`} />
            <View className="flex-1 items-center">
              <Text className={`text-2xl font-bold ${lowScore === null ? t.textPrimary : "text-green-600"}`}>
                {lowScore ?? "—"}
              </Text>
              <Text className={`text-xs font-semibold uppercase tracking-widest mt-0.5 ${t.textTertiary}`}>18-Hole Low</Text>
            </View>
            <View className={`w-px ${t.border} border-l`} />
            <View className="flex-1 items-center">
              <Text className={`text-2xl font-bold ${highScore === null ? t.textPrimary : "text-red-500"}`}>
                {highScore ?? "—"}
              </Text>
              <Text className={`text-xs font-semibold uppercase tracking-widest mt-0.5 ${t.textTertiary}`}>18-Hole High</Text>
            </View>
          </>
        )}
      </View>

      {/* Row 2: Avg Par 3 | Avg Par 4 | Avg Par 5 */}
      <View className={`flex-row border-b ${t.divider} pb-3 mb-3`}>
        {parItems.map((item, i) => (
          <View key={i} className="flex-1 flex-row">
            {i > 0 && <View className={`w-px ${t.border} border-l`} />}
            <View className="flex-1 items-center">
              <Text className={`text-lg font-bold ${item.value === null ? t.textTertiary : t.textPrimary}`}>
                {item.value === null ? "—" : item.value.toFixed(2)}
              </Text>
              <Text className={`text-xs font-semibold uppercase tracking-widest mt-0.5 ${t.textTertiary}`}>
                {item.label}
              </Text>
            </View>
          </View>
        ))}
      </View>

      {/* Scoring distribution donut */}
      <Text className={`text-xs font-semibold uppercase tracking-widest mb-1 ${t.textTertiary}`}>
        Distribution
      </Text>
      {total > 0 ? (
        <Svg viewBox="0 0 300 190" width="100%" height={190}>
          {paths.map((s) => (
            <Path key={`arc-${s.label}`} d={s.d} fill={s.color} />
          ))}
          {paths.map((s) => [
            <Line
              key={`spoke-${s.label}`}
              x1={s.spokeStart.x.toFixed(2)} y1={s.spokeStart.y.toFixed(2)}
              x2={s.spokeEnd.x.toFixed(2)}   y2={s.spokeEnd.y.toFixed(2)}
              stroke={s.color} strokeWidth={1.5}
            />,
            <Line
              key={`elbow-${s.label}`}
              x1={s.spokeEnd.x.toFixed(2)} y1={s.spokeEnd.y.toFixed(2)}
              x2={s.elbowX.toFixed(2)}     y2={s.spokeEnd.y.toFixed(2)}
              stroke={s.color} strokeWidth={1.5}
            />,
            <SvgText
              key={`label-${s.label}`}
              x={s.textCenterX.toFixed(2)}
              y={(s.midY).toFixed(2)}
              textAnchor="middle" fontSize={12} fontWeight="600" fill={s.color}
            >
              {s.label}
            </SvgText>,
            <SvgText
              key={`pct-${s.label}`}
              x={s.textCenterX.toFixed(2)}
              y={(s.midY + 14).toFixed(2)}
              textAnchor="middle" fontSize={12} fontWeight="600" fill={s.color}
            >
              {s.pct}%
            </SvgText>,
          ])}
        </Svg>
      ) : (
        <Text className={`text-sm text-center py-4 ${t.textTertiary}`}>No scores recorded</Text>
      )}
    </View>
  );
}

// ─── DirectionalMissCard ──────────────────────────────────────────────────────

// DirectionalMissCard renders a stat card with a compass-style miss direction graphic.
// Used for both Driving (FIR) and Approach (GIR) sections.
export function DirectionalMissCard({
  sectionLabel, centerLabel, centerValue, miss, denominator, naValue, extraRows,
}: Readonly<{
  sectionLabel: string;
  centerLabel: string;
  centerValue: string;
  miss: { left: number; right: number; short: number; long: number };
  denominator: number;
  naValue?: string;
  extraRows?: { label: string; value: string }[];
}>) {
  const t = useTheme();
  const hasData = centerValue !== "—";

  function pct(count: number): string {
    if (denominator === 0) return "—";
    return `${Math.round((count / denominator) * 100)}%`;
  }

  return (
    <View className={`${t.surface} rounded-2xl border ${t.border} p-4 mb-3`}>
      <Text className={`text-sm font-bold uppercase tracking-widest ${t.textTertiary} mb-2`}>
        {sectionLabel}
      </Text>
      <Text className={`text-xs font-semibold uppercase tracking-widest ${t.textTertiary} mb-2`}>
        Distribution
      </Text>

      <View className="items-center">
        <View className="items-center mb-1">
          <Text className={`text-lg font-bold ${t.textPrimary}`}>{pct(miss.long)}</Text>
          <Text className={`text-sm font-semibold ${t.textTertiary}`}>Long</Text>
        </View>
        <View className="flex-row items-center">
          <View className="items-center w-16">
            <Text className={`text-lg font-bold ${t.textPrimary}`}>{pct(miss.left)}</Text>
            <Text className={`text-sm font-semibold ${t.textTertiary}`}>Left</Text>
          </View>
          <View className={`w-24 h-24 rounded-full border-2 items-center justify-center mx-4 ${hasData ? "bg-green-100 border-green-300" : t.border}`}>
            <Text className={`text-xl font-bold ${hasData ? "text-green-700" : t.textPrimary}`}>{centerValue}</Text>
            <Text className={`text-sm font-semibold ${hasData ? "text-green-600" : t.textTertiary}`}>{centerLabel}</Text>
          </View>
          <View className="items-center w-16">
            <Text className={`text-lg font-bold ${t.textPrimary}`}>{pct(miss.right)}</Text>
            <Text className={`text-sm font-semibold ${t.textTertiary}`}>Right</Text>
          </View>
        </View>
        <View className="items-center mt-1">
          <Text className={`text-lg font-bold ${t.textPrimary}`}>{pct(miss.short)}</Text>
          <Text className={`text-sm font-semibold ${t.textTertiary}`}>Short</Text>
        </View>
      </View>

      {naValue !== undefined && (
        <View className="flex-row justify-end mt-3">
          <Text className={`text-sm ${t.textTertiary}`}>N/A  </Text>
          <Text className={`text-sm font-semibold ${t.textSecondary}`}>{naValue}</Text>
        </View>
      )}

      {extraRows && extraRows.length > 0 && (
        <View className={`mt-4 pt-4 border-t ${t.divider}`}>
          <Text className={`text-xs font-semibold uppercase tracking-widest ${t.textTertiary} mb-2`}>
            Proximity (GIR holes)
          </Text>
          {extraRows.map((row) => (
            <View key={row.label} className={`flex-row items-center justify-between py-2.5 border-b ${t.divider}`}>
              <Text className={`text-base ${t.textSecondary}`}>{row.label}</Text>
              <Text className={`text-base font-semibold ${t.textPrimary}`}>{row.value}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── PuttingCard ──────────────────────────────────────────────────────────────

// PuttingCard renders the Putting section: avg putts/round, a putt-count distribution
// donut, and made-putt distance rows.
export function PuttingCard({
  avgPuttsPerRound, puttDist, avgPuttMadeDistance, longestPuttMade,
}: Readonly<{
  avgPuttsPerRound: number | null;
  puttDist: { one: number; two: number; three: number; fourPlus: number };
  avgPuttMadeDistance: number | null;
  longestPuttMade: number | null;
}>) {
  const t = useTheme();

  const CX = 150, CY = 90, R = 55, IR = 32;
  const SPOKE_R   = 74;
  const ELBOW_LEN = 14;

  const allSlices = [
    { value: puttDist.one,      color: "#16a34a", label: "1 Putt"   },
    { value: puttDist.two,      color: "#3b82f6", label: "2 Putts"  },
    { value: puttDist.three,    color: "#f59e0b", label: "3 Putts"  },
    { value: puttDist.fourPlus, color: "#ef4444", label: "4+ Putts" },
  ];
  const total  = allSlices.reduce((s, x) => s + x.value, 0);
  const slices = allSlices.filter((s) => s.value > 0);

  function toXY(angle: number, radius: number) {
    return { x: CX + radius * Math.cos(angle), y: CY + radius * Math.sin(angle) };
  }

  function arcPath(startAngle: number, sweep: number): string {
    const sw = Math.min(sweep, 2 * Math.PI - 0.001);
    const ea = startAngle + sw;
    const os = toXY(startAngle, R);
    const oe = toXY(ea, R);
    const is = toXY(startAngle, IR);
    const ie = toXY(ea, IR);
    const lg = sw > Math.PI ? 1 : 0;
    return [
      `M ${os.x.toFixed(2)} ${os.y.toFixed(2)}`,
      `A ${R} ${R} 0 ${lg} 1 ${oe.x.toFixed(2)} ${oe.y.toFixed(2)}`,
      `L ${ie.x.toFixed(2)} ${ie.y.toFixed(2)}`,
      `A ${IR} ${IR} 0 ${lg} 0 ${is.x.toFixed(2)} ${is.y.toFixed(2)}`,
      "Z",
    ].join(" ");
  }

  let angle = -Math.PI / 2;
  const paths = slices.map((s) => {
    const sweep    = (s.value / total) * 2 * Math.PI;
    const midAngle = angle + sweep / 2;
    const d        = arcPath(angle, sweep);
    angle += sweep;

    const spokeEnd    = toXY(midAngle, SPOKE_R);
    const isRight     = Math.cos(midAngle) >= 0;
    const elbowX      = spokeEnd.x + (isRight ? ELBOW_LEN : -ELBOW_LEN);
    const textCenterX = elbowX + (isRight ? 24 : -24);
    const pct         = Math.round((s.value / total) * 100);
    const spokeStart  = toXY(midAngle, R);
    return { ...s, d, spokeStart, spokeEnd, elbowX, textCenterX, pct, midY: spokeEnd.y };
  });

  return (
    <View className={`${t.surface} rounded-2xl border ${t.border} p-4 mb-3`}>
      <Text className={`text-sm font-bold uppercase tracking-widest ${t.textTertiary} mb-3`}>
        Putting
      </Text>

      <View className={`flex-row border-b ${t.divider} pb-3 mb-3`}>
        <View className="flex-1 items-center">
          <Text className={`text-2xl font-bold ${avgPuttsPerRound === null ? t.textTertiary : t.textPrimary}`}>
            {avgPuttsPerRound === null ? "—" : avgPuttsPerRound.toFixed(1)}
          </Text>
          <Text className={`text-xs font-semibold uppercase tracking-widest mt-0.5 ${t.textTertiary}`}>Avg Putts / 18 Holes</Text>
        </View>
      </View>

      <Text className={`text-xs font-semibold uppercase tracking-widest mb-1 ${t.textTertiary}`}>
        Distribution
      </Text>
      {total > 0 ? (
        <Svg viewBox="0 0 300 190" width="100%" height={190}>
          {paths.map((s) => (
            <Path key={`arc-${s.label}`} d={s.d} fill={s.color} />
          ))}
          {paths.map((s) => [
            <Line
              key={`spoke-${s.label}`}
              x1={s.spokeStart.x.toFixed(2)} y1={s.spokeStart.y.toFixed(2)}
              x2={s.spokeEnd.x.toFixed(2)}   y2={s.spokeEnd.y.toFixed(2)}
              stroke={s.color} strokeWidth={1.5}
            />,
            <Line
              key={`elbow-${s.label}`}
              x1={s.spokeEnd.x.toFixed(2)} y1={s.spokeEnd.y.toFixed(2)}
              x2={s.elbowX.toFixed(2)}     y2={s.spokeEnd.y.toFixed(2)}
              stroke={s.color} strokeWidth={1.5}
            />,
            <SvgText
              key={`label-${s.label}`}
              x={s.textCenterX.toFixed(2)}
              y={(s.midY).toFixed(2)}
              textAnchor="middle" fontSize={12} fontWeight="600" fill={s.color}
            >
              {s.label}
            </SvgText>,
            <SvgText
              key={`pct-${s.label}`}
              x={s.textCenterX.toFixed(2)}
              y={(s.midY + 14).toFixed(2)}
              textAnchor="middle" fontSize={12} fontWeight="600" fill={s.color}
            >
              {s.pct}%
            </SvgText>,
          ])}
        </Svg>
      ) : (
        <Text className={`text-sm text-center py-4 ${t.textTertiary}`}>No putt data recorded</Text>
      )}

      <View className={`mt-2 pt-4 border-t ${t.divider}`}>
        <Text className={`text-xs font-semibold uppercase tracking-widest ${t.textTertiary} mb-2`}>
          Putt Made Distance
        </Text>
        <View className={`flex-row items-center justify-between py-2.5 border-b ${t.divider}`}>
          <Text className={`text-base ${t.textSecondary}`}>Avg Distance Made</Text>
          <Text className={`text-base font-semibold ${avgPuttMadeDistance === null ? t.textTertiary : t.textPrimary}`}>
            {avgPuttMadeDistance === null ? "—" : `${avgPuttMadeDistance.toFixed(1)} ft`}
          </Text>
        </View>
        <View className={`flex-row items-center justify-between py-2.5 border-b ${t.divider}`}>
          <Text className={`text-base ${t.textSecondary}`}>Longest Putt Made</Text>
          <Text className={`text-base font-semibold ${longestPuttMade === null ? t.textTertiary : t.textPrimary}`}>
            {longestPuttMade === null ? "—" : `${longestPuttMade} ft`}
          </Text>
        </View>
      </View>
    </View>
  );
}
