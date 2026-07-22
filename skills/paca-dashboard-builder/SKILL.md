---
name: paca-dashboard-builder
description: Build and edit panel-based dashboards (charts, tables, text) for a project, the admin instance, or a host Backlog/Sprint/Timeline view — using the com.paca.dashboard plugin's tools. Use when asked to create a dashboard, add a chart/panel, show task/sprint metrics, build a burndown/burnup chart, or rearrange an existing dashboard's layout.
triggers:
  - /paca-dashboard-builder
  - create a dashboard
  - add a panel
  - add a chart
  - build a burndown chart
  - build a burnup chart
  - dashboard layout
---

# Dashboard Builder Skill

This plugin (`com.paca.dashboard`) provides a drag-and-drop panel dashboard — charts, tables, or text blocks — across three scopes: a project's own dashboard, the instance-wide admin dashboard, and one dashboard per host "Dashboard"-type view (Backlog/Sprint/Timeline). Chart/table panels are backed by a single user-authored SQL `SELECT`, guarded server-side before it ever reaches Postgres.

## When to use this skill

Use this when asked to create or edit a dashboard, add or arrange panels, or visualize task/sprint/project data. Every panel needs a SQL query except text panels — the safety rules and preset library below exist so you don't have to hand-write raw SQL against an unfamiliar schema.

## Step 0 — create the host view first (integration-scope dashboards only)

Skip this for the project and admin dashboards — those always exist. An integration-scope dashboard (bound to a Backlog/Sprint/Timeline "Dashboard" view) only exists once that host view has actually been created; `dashboard_get_view({projectId, hostViewId})` needs an existing `hostViewId`, it does **not** create the host-level view itself.

If none exists yet, create it with the core (non-plugin) `create_view` MCP tool — not a `dashboard_*` tool:

```json
{
  "projectId": "<project-uuid>",
  "name": "Dashboard",
  "context": "sprint",
  "sprintId": "<sprint-uuid>",
  "viewType": "plugin",
  "pluginManifestId": "com.paca.dashboard",
  "pluginComponent": "DashboardIntegrationView"
}
```

(`context` is `"sprint"`, `"backlog"`, or `"timeline"`; `sprintId` is only required when `context` is `"sprint"`.) `viewType` must be `"plugin"` — `"dashboard"` is **not** a valid view type and 400s with `VIEW_TYPE_INVALID` (the host's `view_type`s are `table`/`board`/`roadmap`/`plugin`; "Dashboard" is just the label this plugin registers under `viewType: "plugin"`). The returned view's `id` is the `hostViewId` for Step 1 below.

## Step 1 — resolve the dashboard view

Every panel tool needs a `viewId`. Get one first:
- Project dashboard: `dashboard_get_view({projectId})` — get-or-creates the project's singleton, empty on first call.
- A specific Backlog/Sprint/Timeline "Dashboard" view: `dashboard_get_view({projectId, hostViewId})` — `hostViewId` must already exist (see Step 0).
- Admin dashboard: `dashboard_get_admin_view()` — no `viewId` involved; admin panel tools never take one. Requires the caller to hold the `users.write` (instance admin) permission.
- Reloading a view you already have the ID for: `dashboard_get_view({projectId, viewId})`.

## Step 2 — write and validate the query (chart/table panels only)

1. Check "Preset queries" below first — most common requests (status breakdown, burndown, workload, overdue tasks, sprint velocity) already have a working query there. Copy and adapt rather than writing from scratch.
2. If nothing fits, write your own `SELECT` against the schema reference below.
3. Always validate before saving: `dashboard_preview_query({projectId, query})` (or `dashboard_preview_admin_query({query})` for the admin dashboard). This runs the exact same guard the save path uses, so a query that previews cleanly will also save cleanly.
4. If the guard rejects it, the error text explains exactly what's wrong (it may arrive wrapped in a JSON envelope, e.g. `{"success":false,"error":"...","error_code":"..."}`— read the `error` field) — fix and re-preview rather than guessing.

### Query safety rules (enforced server-side, not optional)

- Exactly one statement, and it must start with `SELECT` or `WITH`. No `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`CREATE`/`GRANT`/`TRUNCATE`/`COPY`/`CALL`/`EXPLAIN`/`VACUUM`, and nothing after a trailing `;`.
- No `information_schema`/`pg_catalog`/`pg_*` introspection, `dblink`, `lo_*`.
- **Project and integration-scope queries must contain the literal placeholder `{{project_id}}`** somewhere in a `WHERE`/`ON`/`HAVING` clause (e.g. `WHERE t.project_id = {{project_id}}`) — this is what scopes the query to the caller's own project; the guard substitutes it with a bound `$1` server-side. Never write `$1` yourself — it's reserved and will be rejected.
- **Admin-scope queries must NOT contain `{{project_id}}`** — they're intentionally cross-project.
- A `LIMIT 500` is appended automatically if the query doesn't already declare one — don't rely on getting more than 500 rows back.
- This is a pattern-based guard, not a full SQL parser: prefer straightforward SELECTs over cleverness that might trip a keyword match.

## Step 3 — create or update the panel

`dashboard_create_panel({projectId, viewId, type, title, ...})` (or `dashboard_create_admin_panel` for the admin dashboard, no `viewId`):
- `type: "chart"` needs `chartType` (`bar`|`line`|`donut`) and `query`.
- `type: "table"` needs `query`.
- `type: "text"` needs `content`, no query.

`dashboard_update_panel` / `dashboard_update_admin_panel` are a **full replace**, not a partial patch — resend every field the panel should keep (title, type, and whichever of query/chartType/content apply), not just the one field being changed. Omitting a field clears it, not "leaves it unchanged," and will likely trip the same type-specific validation as create.

Position (`posX`/`posY`/`width`/`height`) can be set at creation or left to defaults (0, 0, 4, 3 on a 12-column grid); adjust several panels at once afterward with `dashboard_update_panel_layout` / `dashboard_update_admin_panel_layout` rather than one-by-one updates.

## Step 4 — verify

After creating or editing a panel, call `dashboard_get_panel_data({projectId, viewId, panelId})` (or the admin equivalent) to confirm it actually returns the data expected — a panel can save successfully and still return zero rows or the wrong shape. A chart panel needs roughly one label column plus one numeric column to render sensibly. Pass `refresh: true` if the query was just changed, since results are cached for up to 5 minutes. Text panels have no query and no data — never call `dashboard_get_panel_data`/`dashboard_get_admin_panel_data` on one.

## Common schema reference

| Table | Key columns |
|---|---|
| `tasks` | `id`, `project_id`, `task_type_id`, `status_id`, `sprint_id`, `parent_task_id`, `title`, `story_points`, `due_date`, `created_at`, `updated_at`, `deleted_at` (soft-delete — always filter `deleted_at IS NULL`) |
| `task_statuses` | `id`, `project_id`, `name`, `category` (`backlog`\|`refinement`\|`ready`\|`todo`\|`inprogress`\|`done`), `position` |
| `task_types` | `id`, `project_id`, `name` (e.g. Task, Epic, Bug) |
| `sprints` | `id`, `project_id`, `name`, `start_date`, `end_date`, `goal`, `status` (`planned`\|`active`\|`completed` — a project can have more than one `active` sprint at once) |
| `task_assignees` | `task_id`, `member_id` (join table; a task can have multiple assignees) |
| `project_members` | `id`, `project_id`, `user_id` (null for agent members) |
| `projects` | `id`, `name`, `created_at` (admin-scope queries only) |

## Preset queries

Copy-paste starting points, already valid against the guard (project/integration ones already include `{{project_id}}`; admin ones don't). Adapt column choices/filters as needed, then always re-validate with preview before saving.

**Tasks by status** (bar chart) — status breakdown in board order:
```sql
SELECT ts.name AS status, COUNT(*) AS task_count
FROM tasks t
JOIN task_statuses ts ON ts.id = t.status_id
WHERE t.project_id = {{project_id}} AND t.deleted_at IS NULL
GROUP BY ts.name, ts.position
ORDER BY ts.position
```

**Tasks by type** (donut chart):
```sql
SELECT tt.name AS task_type, COUNT(*) AS task_count
FROM tasks t
JOIN task_types tt ON tt.id = t.task_type_id
WHERE t.project_id = {{project_id}} AND t.deleted_at IS NULL
GROUP BY tt.name
ORDER BY task_count DESC
```

**Open tasks by assignee** (bar chart):
```sql
SELECT COALESCE(pm.id::text, 'Unassigned') AS assignee, COUNT(DISTINCT t.id) AS open_tasks
FROM tasks t
JOIN task_statuses ts ON ts.id = t.status_id
LEFT JOIN task_assignees ta ON ta.task_id = t.id
LEFT JOIN project_members pm ON pm.id = ta.member_id
WHERE t.project_id = {{project_id}} AND ts.category != 'done' AND t.deleted_at IS NULL
GROUP BY pm.id
ORDER BY open_tasks DESC
```

**Overdue tasks** (table):
```sql
SELECT t.title, t.due_date, ts.name AS status
FROM tasks t
JOIN task_statuses ts ON ts.id = t.status_id
WHERE t.project_id = {{project_id}} AND t.due_date < CURRENT_DATE
  AND ts.category != 'done' AND t.deleted_at IS NULL
ORDER BY t.due_date ASC
```

**Sprint velocity** (bar chart) — story points completed per sprint:
```sql
SELECT s.name AS sprint, COALESCE(SUM(t.story_points), 0) AS points_completed
FROM sprints s
JOIN tasks t ON t.sprint_id = s.id
JOIN task_statuses ts ON ts.id = t.status_id
WHERE s.project_id = {{project_id}} AND ts.category = 'done' AND t.deleted_at IS NULL
GROUP BY s.name, s.start_date
ORDER BY s.start_date
```

**Burndown (active sprint)** (line chart) — remaining open tasks per day:
```sql
SELECT to_char(day, 'YYYY-MM-DD') AS day, SUM(delta) OVER (ORDER BY day::date) AS remaining_tasks
FROM (
  SELECT created_at::date AS day, 1 AS delta
  FROM tasks
  WHERE project_id = {{project_id}}
    AND sprint_id = (SELECT id FROM sprints WHERE project_id = {{project_id}} AND status = 'active' ORDER BY start_date DESC LIMIT 1)
    AND deleted_at IS NULL
  UNION ALL
  SELECT t.updated_at::date AS day, -1 AS delta
  FROM tasks t
  JOIN task_statuses ts ON ts.id = t.status_id
  WHERE t.project_id = {{project_id}}
    AND t.sprint_id = (SELECT id FROM sprints WHERE project_id = {{project_id}} AND status = 'active' ORDER BY start_date DESC LIMIT 1)
    AND ts.category = 'done' AND t.deleted_at IS NULL
) events
ORDER BY day
```

**Admin: tasks by project** (bar chart, instance-wide):
```sql
SELECT p.name AS project, COUNT(t.id) AS task_count
FROM projects p
JOIN tasks t ON t.project_id = p.id
WHERE t.deleted_at IS NULL
GROUP BY p.name
ORDER BY task_count DESC
```

## Building a dashboard from a natural-language request

1. Resolve the view (Step 0 first if it's a new integration-scope dashboard, then Step 1).
2. Break the request into one panel per metric/chart asked for — don't cram multiple unrelated metrics into one query.
3. For each panel: pick a preset if one fits, else write and preview a query (Step 2), then create the panel (Step 3).
4. Verify each panel's data (Step 4).
5. If several panels were added at once, issue one `dashboard_update_panel_layout` call arranging all of them (e.g. two-per-row at width 6, or three-per-row at width 4) rather than leaving everything stacked at the default position.
6. Summarize what was built in one or two sentences — don't restate every tool call.

## Constraints

- Panel `type`/`chartType`/`query`/`content` requirements are enforced server-side; a mismatched combination (e.g. `chart` with no `chartType`) 400s with a message naming exactly what's missing.
- The admin dashboard requires the `users.write` global permission; if a tool call fails there with a permission-style error, the caller isn't an instance admin — don't retry, tell the user.
- `dashboard_get_view`/`dashboard_get_admin_view` return panel metadata only, not query results — always use `dashboard_get_panel_data`/`dashboard_get_admin_panel_data` to see what a panel actually renders.
