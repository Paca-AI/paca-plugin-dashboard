/**
 * SimpleCharts.tsx — bar/line/donut renderers for chart panels, built on
 * Recharts via shadcn/ui's chart primitives (see ./components/ui/chart.tsx,
 * ported verbatim from shadcn's registry — recharts@3.8.0 is the first use
 * of a charting library anywhere in this monorepo, see that file's header
 * comment for why there was previously none).
 *
 * Convention: a chart panel's query result is expected to have exactly two
 * columns — the first treated as the category label, the second as the
 * numeric value. Panels needing more than that should use a table panel
 * instead until/unless multi-series charting is worth the added complexity.
 *
 * Styling: Paca's actual design language ("High-Contrast Minimalism") is one
 * green `--primary` accent over black/white/gray — it has no multi-hue chart
 * palette anywhere in the real UI. The shadcn-scaffolded `--chart-1..5`
 * tokens in index.css are unused boilerplate (default orange/teal/blue/
 * purple/yellow) that never appears in any actual Paca screen, so building
 * this palette from them would look like a foreign rainbow bolted onto an
 * otherwise monochrome+green app. Instead this palette derives from the
 * host's own `--color-primary` via CSS relative-color syntax (`oklch(from
 * var(--color-primary) ...)`), stepping lightness only — same hue/chroma
 * as every button/link/active-state in the app, just lighter or darker —
 * so multi-series charts read as "part of this app" rather than a bolted-
 * on widget. (Relative color syntax needs Chrome 119+/Safari 16.4+/Firefox
 * 128+ — fine for this internal-tooling plugin's target browsers.) Colors
 * are fed into each chart's `ChartConfig`/`<Cell fill>` rather than through
 * the default `--chart-1..5` vars for this same reason.
 *
 * Resize behavior: PanelGrid lets users freely resize a panel's width/height
 * independently (see react-grid-layout usage there). shadcn's ChartContainer
 * defaults to a fixed `aspect-video` box, which would fight that — every
 * chart below overrides it to `aspect-auto h-full w-full` so Recharts'
 * ResponsiveContainer (ResizeObserver-driven) sizes the plot to the panel's
 * actual box instead of a locked 16:9 ratio. Bar/Line recompute their axes
 * against whatever box they're given, so no distortion; Pie's radii are
 * percentage-based (relative to min(width, height)), so the donut stays
 * circular and simply grows/shrinks with the panel instead of needing the
 * manual aspect-ratio/max-width clamping a hand-rolled SVG version needs.
 */

import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart as RechartsLineChart,
  Pie,
  PieChart as RechartsPieChart,
  XAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "./components/ui/chart";
import type { QueryResult } from "./types";

/** Lightness-stepped scale of Paca's own `--color-primary` (same hue+chroma
 *  at every stop, via CSS relative-color syntax) — never fades toward gray
 *  or toward the panel background, so no stop risks blending into muted
 *  text or a card/border surface (verified: min RGB distance from every
 *  real light/dark theme token — background, card, muted, border, muted-
 *  foreground — and between all 4 stops, all comfortably above threshold
 *  in both themes). Simpler and more robust than mixing toward gray/black/
 *  white/transparent, all of which converge toward *some* real UI surface
 *  or text color at one end of the scale. */
const PALETTE = [
  "var(--color-primary)",
  "oklch(from var(--color-primary) calc(l - 0.16) c h)",
  "oklch(from var(--color-primary) calc(l + 0.14) c h)",
  "oklch(from var(--color-primary) calc(l - 0.30) c h)",
];

interface ChartDatum {
  label: string;
  value: number;
}

function toChartData(result: QueryResult): ChartDatum[] {
  if (result.columns.length < 2) return [];
  const [labelCol, valueCol] = result.columns;
  return result.rows.map((row) => ({
    label: String(row[labelCol] ?? ""),
    value: Number(row[valueCol]) || 0,
  }));
}

/** Chart category labels are whatever the first query column returns as
 *  text — usually a status/type/assignee name, but the burndown/burnup
 *  presets (and any user query) group by a date/timestamp column. Postgres
 *  driver quirk: a bare `date` column comes back from the host as a Go
 *  time.Time, which encoding/json marshals as a full RFC3339 timestamp
 *  ("2026-07-19T00:00:00Z") even though the SQL type has no time
 *  component — the presets now cast with to_char(day, 'YYYY-MM-DD') to
 *  avoid that entirely, but this also recognizes the bare ISO-date shape
 *  and, defensively, a full ISO timestamp (in case a user's own custom
 *  query groups by a real timestamp/timestamptz column instead of casting
 *  first). Anything else (status names, "Unassigned", assignee ids, etc.)
 *  passes through unchanged, so this can't misfire on non-date category
 *  labels. Parsed as UTC midnight (not local) so the displayed day never
 *  shifts backward for users west of UTC. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

function formatChartLabel(label: string): string {
  let day = label;
  if (ISO_TIMESTAMP_RE.test(label)) {
    day = label.slice(0, 10);
  } else if (!ISO_DATE_RE.test(label)) {
    return label;
  }
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return label;
  return d.toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function EmptyChartNote({ reason }: { reason: string }) {
  return <p className="text-xs text-muted-foreground">{reason}</p>;
}

export function BarChart({ result }: { result: QueryResult }) {
  const data = toChartData(result);
  if (data.length === 0) return <EmptyChartNote reason="No data to chart yet." />;

  const chartData = data.map((d) => ({ label: formatChartLabel(d.label), value: d.value }));
  const chartConfig: ChartConfig = {
    value: { label: result.columns[1] ?? "Value", color: "var(--color-primary)" },
  };

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-full w-full">
      <RechartsBarChart data={chartData} margin={{ left: 0, right: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--color-border)" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          interval="preserveStartEnd"
        />
        {/* Recharts hardcodes the hover-cursor rectangle's stroke to a
         * literal light gray ("#ccc") — shadcn's chart.tsx only re-themes
         * its fill via a CSS class selector, not the stroke, so that light
         * gray outline shows through as a bright ring around the hovered
         * bar in dark mode. Set both explicitly so no theme-unaware default
         * leaks through. */}
        <ChartTooltip
          cursor={{ fill: "var(--color-muted)", stroke: "none" }}
          content={<ChartTooltipContent hideLabel />}
        />
        <Bar dataKey="value" fill="var(--color-value)" radius={4} />
      </RechartsBarChart>
    </ChartContainer>
  );
}

export function LineChart({ result }: { result: QueryResult }) {
  const data = toChartData(result);
  if (data.length === 0) return <EmptyChartNote reason="No data to chart yet." />;

  const chartData = data.map((d) => ({ label: formatChartLabel(d.label), value: d.value }));
  const chartConfig: ChartConfig = {
    value: { label: result.columns[1] ?? "Value", color: "var(--color-primary)" },
  };

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-full w-full">
      <RechartsLineChart data={chartData} margin={{ left: 0, right: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--color-border)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        {/* Same "#ccc" hardcoded default as the bar chart's cursor, this
         * time on the vertical guide line Recharts draws at the hovered
         * point — set explicitly rather than relying on the class-based
         * CSS override matching. */}
        <ChartTooltip
          cursor={{ stroke: "var(--color-border)", strokeWidth: 1 }}
          content={<ChartTooltipContent hideLabel />}
        />
        <Line
          dataKey="value"
          type="monotone"
          stroke="var(--color-value)"
          strokeWidth={2}
          dot={{ fill: "var(--color-value)", r: 3 }}
          activeDot={{ r: 4 }}
        />
      </RechartsLineChart>
    </ChartContainer>
  );
}

export function DonutChart({ result }: { result: QueryResult }) {
  const data = toChartData(result);
  if (data.length === 0) return <EmptyChartNote reason="No data to chart yet." />;
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (total === 0) return <EmptyChartNote reason="All values are zero." />;

  // Keyed by index (not the raw label) since labels are arbitrary user-query
  // text — may repeat, contain spaces, etc. — and ChartConfig keys need to be
  // stable object-property-safe strings.
  const chartData = data.map((d, i) => ({
    category: `cat${i}`,
    label: formatChartLabel(d.label),
    value: d.value,
    fill: PALETTE[i % PALETTE.length],
  }));
  const chartConfig: ChartConfig = Object.fromEntries(
    chartData.map((d) => [d.category, { label: d.label, color: d.fill }]),
  );

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-full w-full">
      <RechartsPieChart>
        <ChartTooltip content={<ChartTooltipContent nameKey="category" hideLabel />} />
        <Pie
          data={chartData}
          dataKey="value"
          nameKey="category"
          innerRadius="55%"
          outerRadius="85%"
          stroke="var(--background)"
          strokeWidth={2}
        >
          {chartData.map((entry) => (
            <Cell key={entry.category} fill={entry.fill} />
          ))}
        </Pie>
        {/* flex-wrap (on top of ChartLegendContent's defaults) since a
         * dashboard panel's categories come from an arbitrary user query —
         * shadcn's own default legend row doesn't wrap and would overflow
         * once there are more than a handful. */}
        <ChartLegend
          content={<ChartLegendContent nameKey="category" className="flex-wrap" />}
        />
      </RechartsPieChart>
    </ChartContainer>
  );
}
