/**
 * PanelCard.tsx — one panel's chrome: title bar (drag handle + edit/delete),
 * and a body that renders per panel.type. Chart/table panels show a
 * "Refresh" affordance that calls onRunQuery (data isn't auto-fetched for
 * every panel on every render — see DashboardBody.tsx for the fetch-on-
 * mount + manual-refresh policy).
 */

import { GripVertical, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { DashboardPanel, QueryResult } from "./types";
import { BarChart, DonutChart, LineChart } from "./SimpleCharts";

interface PanelCardProps {
  panel: DashboardPanel;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRunQuery: () => void;
  result: QueryResult | undefined;
  isLoading: boolean;
  error: string | undefined;
}

export function PanelCard({
  panel,
  canEdit,
  onEdit,
  onDelete,
  onRunQuery,
  result,
  isLoading,
  error,
}: PanelCardProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border/60 bg-muted/60 shadow-sm">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-3 py-2">
        {canEdit && (
          <span className="panel-drag-handle flex cursor-grab items-center text-muted-foreground/40 active:cursor-grabbing">
            <GripVertical className="size-3.5" />
          </span>
        )}
        <span className="flex-1 min-w-0 truncate text-xs font-semibold text-foreground">
          {panel.title}
        </span>
        {panel.type !== "text" && (
          <button
            type="button"
            onClick={onRunQuery}
            disabled={isLoading}
            aria-label="Refresh panel data"
            className="flex items-center justify-center size-6 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`size-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </button>
        )}
        {canEdit && (
          <>
            <button
              type="button"
              onClick={onEdit}
              aria-label="Edit panel"
              className="flex items-center justify-center size-6 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/40 transition-colors"
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete panel"
              className="flex items-center justify-center size-6 rounded-md text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Trash2 className="size-3.5" />
            </button>
          </>
        )}
      </div>

      <div className="flex-1 overflow-auto p-3">
        <PanelBody panel={panel} result={result} isLoading={isLoading} error={error} />
      </div>
    </div>
  );
}

function PanelBody({
  panel,
  result,
  isLoading,
  error,
}: {
  panel: DashboardPanel;
  result: QueryResult | undefined;
  isLoading: boolean;
  error: string | undefined;
}) {
  if (panel.type === "text") {
    return (
      <p className="whitespace-pre-wrap text-sm text-foreground/90">{panel.content || ""}</p>
    );
  }

  if (error) {
    return <p className="text-xs text-destructive">{error}</p>;
  }
  if (isLoading && !result) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }
  if (!result) {
    return <p className="text-xs text-muted-foreground">No data loaded yet — hit refresh.</p>;
  }

  if (panel.type === "table") {
    return <ResultTable result={result} />;
  }

  // chart
  switch (panel.chart_type) {
    case "line":
      return <LineChart result={result} />;
    case "donut":
      return <DonutChart result={result} />;
    default:
      return <BarChart result={result} />;
  }
}

function ResultTable({ result }: { result: QueryResult }) {
  if (result.rows.length === 0) {
    return <p className="text-xs text-muted-foreground">Query returned no rows.</p>;
  }
  return (
    <div className="overflow-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border/25 text-left uppercase tracking-wide text-muted-foreground/60">
            {result.columns.map((col) => (
              <th key={col} className="px-2 py-1.5 font-semibold whitespace-nowrap">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id from arbitrary queries
            <tr key={i} className="border-b border-border/10 last:border-0">
              {result.columns.map((col) => (
                <td key={col} className="px-2 py-1.5 whitespace-nowrap">
                  {formatCell(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
