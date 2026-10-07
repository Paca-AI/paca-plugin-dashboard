/**
 * presets.ts — curated SQL query templates for common panel setups (task
 * status breakdowns, sprint burndown/burnup, overdue tasks, etc.), so users
 * don't have to hand-write raw SQL from scratch to get a useful dashboard
 * going. Each preset is validated against backend/query_guard.go's actual
 * rules (table whitelist, {{project_id}} placeholder requirement per scope,
 * forbidden keywords) — see the dev notes in that file before adding more.
 *
 * Burndown/burnup scoping: rather than making the user hand-edit a sprint
 * UUID into the query text, both sprint-based presets pick the project's most
 * recently started active sprint and produce one row per day from its start
 * date to today (generate_series), counting tasks with correlated subqueries.
 * That shape is forced by the guard: compound SELECTs (UNION/INTERSECT/EXCEPT)
 * are forbidden, and {{project_id}} must appear exactly once, as a top-level
 * equality filter — so the sprint is selected in the outer query, not in a
 * nested one. To chart a specific sprint instead, replace the start_date
 * condition with `AND s.id = '<uuid>'`.
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

// One row per day of the project's most recently started active sprint.
const ACTIVE_SPRINT_DAYS = `FROM sprints s
CROSS JOIN generate_series(s.start_date::date, CURRENT_DATE, INTERVAL '1 day') AS d
WHERE s.project_id = {{project_id}} AND s.status = 'active'
  AND s.start_date = (SELECT MAX(s2.start_date) FROM sprints s2 WHERE s2.project_id = s.project_id AND s2.status = 'active')
ORDER BY d`;
const SCOPE_BY_DAY = `(SELECT COUNT(*) FROM tasks t WHERE t.sprint_id = s.id AND t.deleted_at IS NULL AND t.created_at::date <= d::date)`;
const DONE_BY_DAY = `(SELECT COUNT(*) FROM tasks t JOIN task_statuses ts ON ts.id = t.status_id
    WHERE t.sprint_id = s.id AND ts.category = 'done' AND t.deleted_at IS NULL AND t.updated_at::date <= d::date)`;

export const QUERY_PRESETS: QueryPreset[] = [
  {
    id: "burndown-active-sprint",
    title: "Burndown (active sprint)",
    description: "Remaining open tasks per day for the project's current active sprint.",
    panelType: "chart",
    chartType: "line",
    scopes: ["project", "integration"],
    query: `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
  ${SCOPE_BY_DAY}
  - ${DONE_BY_DAY} AS remaining_tasks
${ACTIVE_SPRINT_DAYS}`,
  },
  {
    id: "burnup-active-sprint",
    title: "Burnup (active sprint)",
    description: "Total scope vs. completed tasks per day for the current active sprint (two lines).",
    panelType: "chart",
    chartType: "line",
    scopes: ["project", "integration"],
    query: `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
  ${SCOPE_BY_DAY} AS total_scope,
  ${DONE_BY_DAY} AS completed
${ACTIVE_SPRINT_DAYS}`,
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
    description: "Unfinished task load per assignee (unassigned tasks grouped separately).",
    panelType: "chart",
    chartType: "bar",
    scopes: ["project", "integration"],
    query: `SELECT COALESCE(NULLIF(u.full_name, ''), u.username, a.name, 'Unassigned') AS assignee, COUNT(DISTINCT t.id) AS open_tasks
FROM tasks t
JOIN task_statuses ts ON ts.id = t.status_id
LEFT JOIN task_assignees ta ON ta.task_id = t.id
LEFT JOIN project_members pm ON pm.id = ta.member_id
LEFT JOIN users u ON u.id = pm.user_id
LEFT JOIN agents a ON a.id = pm.agent_id
WHERE t.project_id = {{project_id}} AND ts.category != 'done' AND t.deleted_at IS NULL
GROUP BY pm.id, u.full_name, u.username, a.name
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
