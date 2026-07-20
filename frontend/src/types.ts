/**
 * types.ts — response shapes for the dashboard plugin's panel-based
 * dashboard builder. Mirrors the backend's dashboardView/dashboardPanel JSON
 * encodings (see backend/types.go, views.go, panels.go) field for field.
 */

export type DashboardScopeKind = "project" | "admin" | "integration";

export type PanelType = "chart" | "table" | "text";
export type ChartType = "bar" | "line" | "donut";

export interface DashboardPanel {
  id: string;
  dashboard_view_id: string;
  type: PanelType;
  title: string;
  query?: string | null;
  chart_type?: ChartType | null;
  content?: string | null;
  viz_config: Record<string, unknown>;
  pos_x: number;
  pos_y: number;
  width: number;
  height: number;
  created_at: string;
  updated_at: string;
}

export interface DashboardView {
  id: string;
  project_id?: string | null;
  scope: DashboardScopeKind;
  /** Set only for scope="integration": the host's own interaction-view id
   * this dashboard is a singleton for. See backend/types.go. */
  host_view_id?: string | null;
  name: string;
  panels: DashboardPanel[];
  created_at: string;
  updated_at: string;
}

/** Body sent when creating/updating a panel. */
export interface PanelInput {
  type: PanelType;
  title: string;
  query?: string | null;
  chart_type?: ChartType | null;
  content?: string | null;
  viz_config?: Record<string, unknown>;
  pos_x?: number;
  pos_y?: number;
  width?: number;
  height?: number;
}

/** One row of a bulk drag/resize layout commit. */
export interface PanelLayoutEntry {
  id: string;
  pos_x: number;
  pos_y: number;
  width: number;
  height: number;
}

/** Response shape of the panel-data / query-preview endpoints. */
export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** A structured error surfaced by the backend query guard (400 body). */
export interface QueryGuardError {
  message: string;
}
