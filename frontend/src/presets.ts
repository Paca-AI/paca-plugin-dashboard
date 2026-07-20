/**
 * presets.ts — curated SQL query templates for common panel setups (task
 * status breakdowns, sprint burndown/burnup, overdue tasks, etc.), so users
 * don't have to hand-write raw SQL from scratch to get a useful dashboard
 * going. Each preset is validated against backend/query_guard.go's actual
 * rules (table whitelist, {{project_id}} placeholder requirement per scope,
 * forbidden keywords) — see the dev notes in that file before adding more.
 *
 * Burndown/burnup scoping: rather than making the user hand-edit a sprint
 * UUID into the query text, both sprint-based presets resolve "the active
 * sprint" via a correlated subquery on sprints.status = 'active'. If a
 * project runs multiple concurrent active sprints (schema allows it, see
 * database-schema.md), the subquery's own filter still yields a single
 * chart per query invocation — the query returns one row per day across
 * whichever active sprint(s) match; if that's ever ambiguous for a given
 * project, the user can copy the preset text and hand-tune the WHERE
 * clause (e.g. add `AND sprint_id = '<uuid>'` for a specific sprint).
 */

import type { ChartType, DashboardScopeKind, PanelType } from "./types";

export interface QueryPreset {
  id: string;
  title: string;
  description: string;
  panelType: Extract<PanelType, "chart" | "table">;
  chartType?: ChartType;
  /** Scopes this preset is meaningful/valid for (admin queries must NOT use {{project_id}}). */
  scopes: DashboardScopeKind[];
  query: string;
}

const ACTIVE_SPRINT = `(SELECT id FROM sprints WHERE project_id = {{project_id}} AND status = 'active' ORDER BY start_date DESC LIMIT 1)`;

export const QUERY_PRESETS: QueryPreset[] = [
  {
    id: "burndown-active-sprint",
    title: "Burndown (active sprint)",
    description: "Remaining open tasks per day for the project's current active sprint.",
    panelType: "chart",
    chartType: "line",
    scopes: ["project", "integration"],
    query: `SELECT to_char(day, 'YYYY-MM-DD') AS day, SUM(delta) OVER (ORDER BY day::date) AS remaining_tasks
FROM (
  SELECT created_at::date AS day, 1 AS delta
  FROM tasks
  WHERE project_id = {{project_id}} AND sprint_id = ${ACTIVE_SPRINT} AND deleted_at IS NULL
  UNION ALL
  SELECT t.updated_at::date AS day, -1 AS delta
  FROM tasks t
  JOIN task_statuses ts ON ts.id = t.status_id
  WHERE t.project_id = {{project_id}} AND t.sprint_id = ${ACTIVE_SPRINT}
    AND ts.category = 'done' AND t.deleted_at IS NULL
) events
ORDER BY day`,
  },
  {
    id: "burnup-active-sprint",
    title: "Burnup (active sprint)",
    description: "Total scope vs. completed tasks per day for the current active sprint (two lines).",
    panelType: "chart",
    chartType: "line",
    scopes: ["project", "integration"],
    query: `SELECT to_char(day, 'YYYY-MM-DD') AS day,
       SUM(scope_delta) OVER (ORDER BY day::date) AS total_scope,
       SUM(done_delta) OVER (ORDER BY day::date) AS completed
FROM (
  SELECT created_at::date AS day, 1 AS scope_delta, 0 AS done_delta
  FROM tasks
  WHERE project_id = {{project_id}} AND sprint_id = ${ACTIVE_SPRINT} AND deleted_at IS NULL
  UNION ALL
  SELECT t.updated_at::date AS day, 0 AS scope_delta, 1 AS done_delta
  FROM tasks t
  JOIN task_statuses ts ON ts.id = t.status_id
  WHERE t.project_id = {{project_id}} AND t.sprint_id = ${ACTIVE_SPRINT}
    AND ts.category = 'done' AND t.deleted_at IS NULL
) events
ORDER BY day`,
  },
  {
    id: "tasks-by-status",
    title: "Tasks by status",
    description: "How many tasks currently sit in each status column, in board order.",
    panelType: "chart",
    chartType: "bar",
    scopes: ["project", "integration"],
    query: `SELECT ts.name AS status, COUNT(*) AS task_count
FROM tasks t
JOIN task_statuses ts ON ts.id = t.status_id
WHERE t.project_id = {{project_id}} AND t.deleted_at IS NULL
GROUP BY ts.name, ts.position
ORDER BY ts.position`,
  },
  {
    id: "tasks-by-type",
    title: "Tasks by type",
    description: "Task type distribution (e.g. Task, Epic, Bug) for this project.",
    panelType: "chart",
    chartType: "donut",
    scopes: ["project", "integration"],
    query: `SELECT tt.name AS task_type, COUNT(*) AS task_count
FROM tasks t
JOIN task_types tt ON tt.id = t.task_type_id
WHERE t.project_id = {{project_id}} AND t.deleted_at IS NULL
GROUP BY tt.name
ORDER BY task_count DESC`,
  },
  {
    id: "open-tasks-by-assignee",
    title: "Open tasks by assignee",
    description: "Unfinished task load per assignee (member id shown; unassigned tasks grouped separately).",
    panelType: "chart",
    chartType: "bar",
    scopes: ["project", "integration"],
    query: `SELECT COALESCE(pm.id::text, 'Unassigned') AS assignee, COUNT(DISTINCT t.id) AS open_tasks
FROM tasks t
JOIN task_statuses ts ON ts.id = t.status_id
LEFT JOIN task_assignees ta ON ta.task_id = t.id
LEFT JOIN project_members pm ON pm.id = ta.member_id
WHERE t.project_id = {{project_id}} AND ts.category != 'done' AND t.deleted_at IS NULL
GROUP BY pm.id
ORDER BY open_tasks DESC`,
  },
  {
    id: "overdue-tasks",
    title: "Overdue tasks",
    description: "Open tasks whose due date has already passed, soonest-overdue first.",
    panelType: "table",
    scopes: ["project", "integration"],
    query: `SELECT t.title, t.due_date, ts.name AS status
FROM tasks t
JOIN task_statuses ts ON ts.id = t.status_id
WHERE t.project_id = {{project_id}} AND t.due_date < CURRENT_DATE
  AND ts.category != 'done' AND t.deleted_at IS NULL
ORDER BY t.due_date ASC`,
  },
  {
    id: "sprint-velocity",
    title: "Sprint velocity",
    description: "Story points completed per sprint, in sprint start-date order.",
    panelType: "chart",
    chartType: "bar",
    scopes: ["project", "integration"],
    query: `SELECT s.name AS sprint, COALESCE(SUM(t.story_points), 0) AS points_completed
FROM sprints s
JOIN tasks t ON t.sprint_id = s.id
JOIN task_statuses ts ON ts.id = t.status_id
WHERE s.project_id = {{project_id}} AND ts.category = 'done' AND t.deleted_at IS NULL
GROUP BY s.name, s.start_date
ORDER BY s.start_date`,
  },
  {
    id: "admin-tasks-by-project",
    title: "Tasks by project",
    description: "Task count per project, across the whole instance.",
    panelType: "chart",
    chartType: "bar",
    scopes: ["admin"],
    query: `SELECT p.name AS project, COUNT(t.id) AS task_count
FROM projects p
JOIN tasks t ON t.project_id = p.id
WHERE t.deleted_at IS NULL
GROUP BY p.name
ORDER BY task_count DESC`,
  },
  {
    id: "admin-tasks-by-status-category",
    title: "Tasks by status category (all projects)",
    description: "Instance-wide task count grouped by status category (backlog, in progress, done, etc.).",
    panelType: "chart",
    chartType: "donut",
    scopes: ["admin"],
    query: `SELECT ts.category AS status_category, COUNT(*) AS task_count
FROM tasks t
JOIN task_statuses ts ON ts.id = t.status_id
WHERE t.deleted_at IS NULL
GROUP BY ts.category
ORDER BY task_count DESC`,
  },
  {
    id: "admin-projects-overview",
    title: "Projects overview",
    description: "Every project on the instance with its total task count, newest first.",
    panelType: "table",
    scopes: ["admin"],
    query: `SELECT p.name, p.created_at, COUNT(t.id) AS total_tasks
FROM projects p
LEFT JOIN tasks t ON t.project_id = p.id AND t.deleted_at IS NULL
GROUP BY p.id, p.name, p.created_at
ORDER BY p.created_at DESC`,
  },
];

export function presetsForScope(scope: DashboardScopeKind): QueryPreset[] {
  return QUERY_PRESETS.filter((p) => p.scopes.includes(scope));
}

/**
 * Presets valid for both the given scope AND the currently-selected panel
 * type. Presets are query-driven (chart/table only — "text" panels have no
 * query), so a preset built for a table (e.g. "Overdue tasks") shouldn't be
 * offered while the user has "chart" selected, and vice versa: applying it
 * would silently flip their panel type out from under them.
 */
export function presetsForScopeAndType(
  scope: DashboardScopeKind,
  panelType: Extract<PanelType, "chart" | "table">,
): QueryPreset[] {
  return QUERY_PRESETS.filter((p) => p.scopes.includes(scope) && p.panelType === panelType);
}
