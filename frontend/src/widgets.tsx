/**
 * widgets.tsx — small dependency-free presentational widgets used by
 * DashboardPage: a stat card, a horizontal status-breakdown bar chart, and a
 * segmented progress bar. Deliberately built with plain CSS/inline SVG
 * rather than a charting library — no charting/grid dependency exists
 * anywhere else in the monorepo (see other plugins' package.json), and
 * these widgets are simple enough (bars, a stat number, a progress track)
 * that pulling in e.g. recharts would add a real dependency for very little
 * benefit.
 */

// ── StatCard ──────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string | number;
  sublabel?: string;
}

export function StatCard({ label, value, sublabel }: StatCardProps) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/25 bg-card/30 p-4">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">
        {label}
      </span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {sublabel && (
        <span className="text-xs text-muted-foreground">{sublabel}</span>
      )}
    </div>
  );
}

// ── StatusBreakdownChart ──────────────────────────────────────────────────────

export interface StatusBarDatum {
  key: string;
  label: string;
  color: string;
  count: number;
}

/**
 * Horizontal bar per status, each bar's width proportional to its share of
 * the total. Renders an empty-state message when there are no tasks yet
 * rather than a row of zero-width bars.
 */
export function StatusBreakdownChart({ data }: { data: StatusBarDatum[] }) {
  const total = data.reduce((sum, d) => sum + d.count, 0);

  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No tasks yet — the status breakdown will appear here once tasks are
        created.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {data.map((d) => {
        const pct = total === 0 ? 0 : (d.count / total) * 100;
        return (
          <div key={d.key} className="flex items-center gap-3">
            <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
              {d.label}
            </span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted/40">
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${pct}%`, backgroundColor: d.color }}
              />
            </div>
            <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {d.count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── ProgressBar ───────────────────────────────────────────────────────────────

interface ProgressBarProps {
  /** 0–100 */
  percent: number;
  label: string;
  sublabel?: string;
}

export function ProgressBar({ percent, label, sublabel }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {clamped}%{sublabel ? ` · ${sublabel}` : ""}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted/40">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

// ── WorkloadBarChart ──────────────────────────────────────────────────────────

export interface WorkloadDatum {
  key: string;
  label: string;
  openCount: number;
  totalCount: number;
}

/**
 * One horizontal bar per project member: a filled segment for open tasks
 * and a lighter segment for the remainder of their total assigned tasks,
 * scaled against the busiest member so bars are comparable at a glance.
 */
export function WorkloadBarChart({ data }: { data: WorkloadDatum[] }) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No assigned tasks yet — member workload will appear here once tasks
        are assigned.
      </p>
    );
  }

  const max = Math.max(...data.map((d) => d.totalCount), 1);

  return (
    <div className="flex flex-col gap-2.5">
      {data.map((d) => {
        const openPct = (d.openCount / max) * 100;
        const totalPct = (d.totalCount / max) * 100;
        return (
          <div key={d.key} className="flex items-center gap-3">
            <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
              {d.label}
            </span>
            <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted/40">
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground/30"
                style={{ width: `${totalPct}%` }}
              />
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-primary"
                style={{ width: `${openPct}%` }}
              />
            </div>
            <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {d.openCount}/{d.totalCount}
            </span>
          </div>
        );
      })}
    </div>
  );
}
