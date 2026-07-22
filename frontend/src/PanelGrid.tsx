/**
 * PanelGrid.tsx — the drag/resize grid canvas shared by every dashboard
 * scope. Wraps react-grid-layout v2 (`GridLayout` + `useContainerWidth`) and
 * renders one <PanelCard> per dashboard_panels row. Layout changes are
 * batched into a single `PUT .../panels/layout` commit on drag/resize stop
 * rather than firing on every intermediate `onLayoutChange` tick.
 */

import { GridLayout, useContainerWidth, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "./grid-overrides.css";
import { useCallback, useState } from "react";
import type { DashboardPanel, PanelLayoutEntry } from "./types";
import { PanelCard } from "./PanelCard";

const COLS = 12;
const ROW_HEIGHT = 56;

interface PanelGridProps {
  panels: DashboardPanel[];
  canEdit: boolean;
  onLayoutCommit: (entries: PanelLayoutEntry[]) => void;
  onEditPanel: (panel: DashboardPanel) => void;
  onDeletePanel: (panel: DashboardPanel) => void;
  onRunQuery: (panel: DashboardPanel) => void;
  queryResultsByPanelId: Record<string, { columns: string[]; rows: Record<string, unknown>[] } | undefined>;
  loadingPanelIds: Set<string>;
  errorsByPanelId: Record<string, string | undefined>;
}

export function PanelGrid({
  panels,
  canEdit,
  onLayoutCommit,
  onEditPanel,
  onDeletePanel,
  onRunQuery,
  queryResultsByPanelId,
  loadingPanelIds,
  errorsByPanelId,
}: PanelGridProps) {
  const { width, containerRef, mounted } = useContainerWidth();

  // Local layout state so drag/resize feels instant; committed to the
  // backend only onDragStop/onResizeStop, not on every intermediate tick.
  const [layout, setLayout] = useState<Layout>(() =>
    panels.map((p) => ({ i: p.id, x: p.pos_x, y: p.pos_y, w: p.width, h: p.height, minW: 2, minH: 2 })),
  );

  // Keep local layout in sync when the panel list itself changes (new
  // panel added/removed) without clobbering in-flight drag state.
  const panelIds = panels.map((p) => p.id).join(",");
  const [lastPanelIds, setLastPanelIds] = useState(panelIds);
  if (panelIds !== lastPanelIds) {
    setLastPanelIds(panelIds);
    setLayout(panels.map((p) => ({ i: p.id, x: p.pos_x, y: p.pos_y, w: p.width, h: p.height, minW: 2, minH: 2 })));
  }

  const commitLayout = useCallback(
    (next: Layout) => {
      setLayout(next);
      const entries: PanelLayoutEntry[] = next.map((item) => ({
        id: item.i,
        pos_x: item.x,
        pos_y: item.y,
        width: item.w,
        height: item.h,
      }));
      onLayoutCommit(entries);
    },
    [onLayoutCommit],
  );

  if (panels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/50 bg-muted/20 py-16 text-center">
        <p className="text-sm font-medium text-foreground">No panels yet</p>
        <p className="text-xs text-muted-foreground max-w-sm">
          {canEdit
            ? "Add a chart, table, or text panel to start building this dashboard."
            : "This dashboard doesn't have any panels yet."}
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full">
      {mounted && (
        <GridLayout
          width={width}
          layout={layout}
          gridConfig={{ cols: COLS, rowHeight: ROW_HEIGHT, margin: [12, 12], containerPadding: [0, 0] }}
          dragConfig={{ enabled: canEdit, handle: ".panel-drag-handle" }}
          resizeConfig={{ enabled: canEdit }}
          autoSize
          onDragStop={(layoutAfter: Layout) => commitLayout(layoutAfter)}
          onResizeStop={(layoutAfter: Layout) => commitLayout(layoutAfter)}
        >
          {panels.map((panel) => (
            <div key={panel.id}>
              <PanelCard
                panel={panel}
                canEdit={canEdit}
                onEdit={() => onEditPanel(panel)}
                onDelete={() => onDeletePanel(panel)}
                onRunQuery={() => onRunQuery(panel)}
                result={queryResultsByPanelId[panel.id]}
                isLoading={loadingPanelIds.has(panel.id)}
                error={errorsByPanelId[panel.id]}
              />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
