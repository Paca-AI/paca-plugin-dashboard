# com.paca.dashboard

First-party Paca plugin that provides at-a-glance project and instance-wide
dashboards. It reads existing task, sprint, and membership data — it owns no
tables of its own and requires no migration.

---

## Architecture

The plugin follows the standard three-part plugin structure:

```
dashboard/
├── backend/   — Go WASM plugin (runs inside the API host)
├── frontend/  — React micro-frontend (Module Federation remote)
└── mcp/       — MCP tool server (for AI agent access)
```

### Backend (`backend/`)

- Written in Go, compiled to `wasip1/wasm` for production.
- Registered as `com.paca.dashboard` in the plugin registry.
- Owns no database schema — every route computes aggregates on demand via
  raw parameterized SQL against the host's core tables (`tasks`,
  `task_statuses`, `sprints`, `task_assignees`, `project_members`, `users`,
  `projects`). Nothing to migrate, nothing to cascade-delete.
- Two read-only routes: a per-project overview and a cross-project
  instance overview (see API Endpoints below).

### Frontend (`frontend/`)

- Vite + React + TanStack Query.
- Exposed as a Module Federation remote (`com_paca_dashboard`) with two
  entry points:
  - `./ProjectDashboardPage` — rendered via the `project.page` extension
    point at its own routed page
    (`/projects/:projectId/plugins/com.paca.dashboard/dashboard`), reached
    through a nav item this plugin registers in the project sidebar.
    Shows task status breakdown, the active sprint's task/story-point
    burndown, and member workload — all for the current project.
  - `./AdminDashboardPage` — rendered via the `admin.page` extension point
    at its own routed page (`/admin/plugins/com.paca.dashboard/dashboard`),
    reached through a nav item this plugin registers in the admin sidebar.
    Cross-project view: task totals and open/done counts per project across
    the whole instance.
- Widgets (`widgets.tsx`) are dependency-free — stat cards and inline-SVG
  bar/donut charts — so the plugin adds no charting or grid-layout library
  to the bundle.
- Communicates with the backend through the standard plugin API path:  
  `GET /api/v1/plugins/com.paca.dashboard/projects/:projectId/dashboard/overview`
  (project-scoped) and `GET /api/v1/plugins/com.paca.dashboard/dashboard/overview-all`
  (global/admin-scoped, no `:projectId`).

### Authorization

Both routes are read-only (`GET`) and gated entirely by the host's
`requirePermissions` route middleware, declared per-route in `plugin.json`
— there is no additional in-handler permission check:

- Project overview — requires the built-in `projects.read` permission (any
  project member can view their own project's dashboard).
- Instance overview — requires the built-in `users.write` (admin)
  permission, since it exposes cross-project data outside any single
  project's membership boundary.

### MCP (`mcp/`)

- Exposes `dashboard_project_overview` and `dashboard_instance_overview`
  tools so AI agents can query the same aggregates on behalf of a user.

---

## API Endpoints

### Project-scoped

Prefixed with `/projects/:projectId` by the host. Requires `projects.read`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard/overview` | Task status breakdown, active sprint progress (tasks + story points), and per-member workload for the project |

### Global/admin-scoped

No `:projectId`. Requires `users.write`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard/overview-all` | Task totals and open/done counts, per project, across the whole instance |

### Response examples

**Project overview** — `GET /dashboard/overview`
```json
{
  "data": {
    "total_tasks": 42,
    "total_story_points": 89,
    "status_breakdown": [
      { "status_id": "…", "status_name": "To Do", "color": "#94a3b8", "category": "todo", "count": 12 },
      { "status_id": "…", "status_name": "In Progress", "color": "#3b82f6", "category": "in_progress", "count": 8 },
      { "status_id": "…", "status_name": "Done", "color": "#22c55e", "category": "done", "count": 22 }
    ],
    "active_sprint": {
      "id": "…", "name": "Sprint 14", "start_date": "2026-07-07", "end_date": "2026-07-21",
      "goal": "Ship the dashboard plugin",
      "total_tasks": 18, "done_tasks": 11,
      "total_story_points": 40, "done_story_points": 25,
      "percent_tasks_done": 61.1, "percent_points_done": 62.5
    },
    "workload": [
      { "member_id": "…", "member_name": "Ada Lovelace", "open_task_count": 3, "total_task_count": 9 }
    ]
  }
}
```

**Instance overview** — `GET /dashboard/overview-all`
```json
{
  "data": {
    "project_count": 2,
    "total_tasks": 67,
    "total_open_tasks": 30,
    "projects": [
      { "project_id": "…", "project_name": "Paca Core", "total_tasks": 42, "open_tasks": 20, "done_tasks": 22 },
      { "project_id": "…", "project_name": "Paca Mobile", "total_tasks": 25, "open_tasks": 10, "done_tasks": 15 }
    ]
  }
}
```

---

## Database Schema

None — this plugin owns no tables and runs no migrations. All data is
read via parameterized SQL against the host's existing `public.*` schema
(`tasks`, `task_statuses`, `sprints`, `task_assignees`, `project_members`,
`users`, `projects`).

---

## Development

### Backend

```bash
cd backend

# Run tests
go test -race -v ./...

# Lint
golangci-lint run --timeout=5m

# Build WASM binary (requires Go 1.24+)
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o dashboard.wasm .
```

**Test coverage note:** `plugintest`'s `InMemoryDB` only supports
single-table `SELECT ... FROM t [WHERE col = $N]` queries — it cannot
execute this plugin's JOIN/GROUP BY aggregation SQL (the same limitation
already documented in `paca-plugin-time-logging`'s admin-scope tests, see
`plugin_test.go`'s `TestProjectOverview_WiredUp`/`TestInstanceOverview_WiredUp`
comments). Those tests only assert the routes are wired up and fail/succeed
predictably against an unseeded DB; full aggregation correctness should be
verified against a real Postgres instance in an integration/e2e suite.

### Frontend

```bash
cd frontend

# Install dependencies
bun install

# Typecheck
bun run typecheck

# Development build (watch)
bun run dev

# Production build (outputs remoteEntry.js)
bun run build
```

The frontend uses the `@paca-ai/plugin-sdk-react` package.  
Shared singletons (`react`, `react-dom`, `@tanstack/react-query`) are provided
by the host shell and must not be bundled.

### MCP

```bash
cd mcp

bun install
bun run typecheck
bun run build
```

---

## Extension Points

### `project.page` — `ProjectDashboardPage`

Routed at `/projects/:projectId/plugins/com.paca.dashboard/dashboard` via
the `project` nav item declared in `plugin.json`.

| Prop | Type | Description |
|------|------|-------------|
| `projectId` | `string` | Current project ID |

### `admin.page` — `AdminDashboardPage`

Routed at `/admin/plugins/com.paca.dashboard/dashboard` via the `admin`
nav item declared in `plugin.json`. Takes no props beyond the shared
`BaseExtensionProps` (`api`, `ui`, `meta`) — there is no `projectId` in this
scope.
