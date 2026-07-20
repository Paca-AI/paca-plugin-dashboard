// views.go — dashboard_views CRUD across the three scopes (project, admin,
// integration). See migrations/0001_create_dashboard_tables.sql for the
// table shape and the partial-unique-index enforcement of "exactly one"
// project/admin dashboard.
//
// Every query here is deliberately written as a single-table SELECT with a
// plain AND-chain of "col = $N" conditions (no OR, no parens) — this isn't
// just a style choice, it's what plugintest.InMemoryDB's minimal SQL parser
// can execute, so the same handler code is exercised in both the real
// Postgres backend and unit tests. Where scope changes which columns are
// relevant (project vs admin has NULL vs a real project_id), the two cases
// are branched into separate queries rather than expressed as one query
// with an OR.
package main

import (
	plugin "github.com/Paca-AI/plugin-sdk-go"
)

// ── Project scope: get-or-create singleton ─────────────────────────────────

// getOrCreateProjectView handles GET /dashboard/view (relative;
// /projects/:projectId/dashboard/view via the manifest). Returns the
// project's single dashboard, creating an empty one on first visit.
func (p *dashboardPlugin) getOrCreateProjectView(req *plugin.Request, res *plugin.Response) {
	projectID := req.Caller.ProjectID
	view, err := p.fetchOrCreateSingletonView(projectID, "project", "", "Dashboard", req.Caller.CallerID)
	if err != nil {
		p.log.Error("getOrCreateProjectView: " + err.Error())
		res.Error(500, "failed to load project dashboard")
		return
	}
	ok(res, view)
}

// ── Admin scope: get-or-create singleton (no project) ──────────────────────

// getOrCreateAdminView handles GET /dashboard/admin-view (no :projectId —
// admin.page components have no project context). Returns the single
// instance-wide dashboard, creating an empty one on first visit.
func (p *dashboardPlugin) getOrCreateAdminView(req *plugin.Request, res *plugin.Response) {
	view, err := p.fetchOrCreateSingletonView("", "admin", "", "Admin Dashboard", req.Caller.CallerID)
	if err != nil {
		p.log.Error("getOrCreateAdminView: " + err.Error())
		res.Error(500, "failed to load admin dashboard")
		return
	}
	ok(res, view)
}

// ── Integration scope: get-or-create singleton, one per host view ─────────

// getOrCreateIntegrationView handles GET /dashboard/view/:hostViewId
// (relative; /projects/:projectId/dashboard/view/:hostViewId via the
// manifest). Returns the single dashboard belonging to this specific host
// interaction view (a "Dashboard"-type view created via the host's own "Add
// view" popover in Backlog/Sprint/Timeline), creating an empty one on first
// visit — same get-or-create-singleton shape as the project/admin scopes,
// just keyed by hostViewId instead of projectID/"".
func (p *dashboardPlugin) getOrCreateIntegrationView(req *plugin.Request, res *plugin.Response) {
	projectID := req.Caller.ProjectID
	hostViewID := req.PathParam("hostViewId")
	if hostViewID == "" {
		res.Error(400, "hostViewId is required")
		return
	}
	view, err := p.fetchOrCreateSingletonView(projectID, "integration", hostViewID, "Dashboard", req.Caller.CallerID)
	if err != nil {
		p.log.Error("getOrCreateIntegrationView: " + err.Error())
		res.Error(500, "failed to load dashboard view")
		return
	}
	ok(res, view)
}

// fetchOrCreateSingletonView looks up the one dashboard_views row for the
// given (projectID, scope, hostViewID) combination — projectID is "" for the
// admin scope, hostViewID is "" for the project/admin scopes — and creates
// it if absent. In production, the partial unique indexes on
// dashboard_views (uq_dashboard_views_one_project_scope /
// uq_dashboard_views_one_admin_scope / uq_dashboard_views_one_per_host_view)
// guarantee at most one row ever exists per key even under a concurrent
// first-visit race.
func (p *dashboardPlugin) fetchOrCreateSingletonView(projectID, scope, hostViewID, defaultName, callerID string) (*dashboardView, error) {
	existing, err := p.queryViewsByScope(projectID, scope, hostViewID)
	if err != nil {
		return nil, err
	}
	if len(existing) > 0 {
		return &existing[0], nil
	}

	createdBy := nullableUUID(callerID)
	var insertResult *plugin.DBQueryResult
	switch scope {
	case "admin":
		insertResult, err = p.db.Query(
			`INSERT INTO dashboard_views (project_id, scope, host_view_id, name, created_by)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING id, project_id, scope, host_view_id, name, created_at, updated_at`,
			nil, "admin", nil, defaultName, createdBy,
		)
	case "integration":
		insertResult, err = p.db.Query(
			`INSERT INTO dashboard_views (project_id, scope, host_view_id, name, created_by)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING id, project_id, scope, host_view_id, name, created_at, updated_at`,
			projectID, "integration", hostViewID, defaultName, createdBy,
		)
	default:
		insertResult, err = p.db.Query(
			`INSERT INTO dashboard_views (project_id, scope, host_view_id, name, created_by)
			 VALUES ($1, $2, $3, $4, $5)
			 RETURNING id, project_id, scope, host_view_id, name, created_at, updated_at`,
			projectID, "project", nil, defaultName, createdBy,
		)
	}
	if err != nil {
		return nil, err
	}
	if len(insertResult.Rows) == 0 {
		return nil, err
	}

	view := viewFromRow(insertResult.Columns, insertResult.Rows[0])
	view.Panels = []dashboardPanel{}
	return &view, nil
}

// getView handles GET /dashboard/views/:viewId (any scope — used by the
// panel editor to reload a view after a save).
func (p *dashboardPlugin) getView(req *plugin.Request, res *plugin.Response) {
	viewID := req.PathParam("viewId")
	view, loaded := p.loadViewWithPanels(viewID, req.Caller.ProjectID, res)
	if !loaded {
		return
	}
	ok(res, view)
}

// ── Shared query/load helpers ────────────────────────────────────────────────

// queryViewsByScope returns dashboard_views rows (with panels embedded)
// matching (projectID, scope, hostViewID). projectID is ignored for the
// admin scope; hostViewID is only meaningful for the integration scope
// (empty string is never a valid host_view_id, so it can't accidentally
// match a real row there — project/admin rows always have host_view_id
// NULL and are matched without it).
func (p *dashboardPlugin) queryViewsByScope(projectID, scope, hostViewID string) ([]dashboardView, error) {
	var result *plugin.DBQueryResult
	var err error
	switch scope {
	case "admin":
		result, err = p.db.Query(
			`SELECT id, project_id, scope, host_view_id, name, created_at, updated_at
			 FROM dashboard_views WHERE scope = $1`,
			scope,
		)
	case "integration":
		result, err = p.db.Query(
			`SELECT id, project_id, scope, host_view_id, name, created_at, updated_at
			 FROM dashboard_views WHERE host_view_id = $1 AND scope = $2`,
			hostViewID, scope,
		)
	default:
		result, err = p.db.Query(
			`SELECT id, project_id, scope, host_view_id, name, created_at, updated_at
			 FROM dashboard_views WHERE project_id = $1 AND scope = $2`,
			projectID, scope,
		)
	}
	if err != nil {
		return nil, err
	}

	views := make([]dashboardView, 0, len(result.Rows))
	for _, row := range result.Rows {
		v := viewFromRow(result.Columns, row)
		panels, err := p.fetchPanelsForView(v.ID)
		if err != nil {
			return nil, err
		}
		v.Panels = panels
		views = append(views, v)
	}
	return views, nil
}

// resolveViewID returns the dashboard_views id that a panel route (create/
// update/delete/layout/data) should operate on. Project- and integration-
// scope routes carry :viewId in their manifest path (e.g.
// /projects/:projectId/dashboard/views/:viewId/panels), so it's read
// straight from the path. Admin-scope routes don't — /dashboard/admin-view/
// panels has no :viewId segment, since the admin dashboard is a global
// singleton the frontend never needs to address by id (see viewBasePath in
// frontend/src/api.ts) — so req.PathParam("viewId") would silently return
// "" there. Reading that "" as a UUID param blew up downstream with
// "invalid input syntax for type uuid" (SQLSTATE 22P02); instead, for the
// admin scope (projectID == "") we resolve the singleton directly,
// get-or-creating it just like getOrCreateAdminView does so a panel-mutating
// call can't 404 ahead of the page's own first GET.
func (p *dashboardPlugin) resolveViewID(req *plugin.Request, projectID string, res *plugin.Response) (string, bool) {
	if projectID != "" {
		viewID := req.PathParam("viewId")
		if viewID == "" {
			res.Error(400, "viewId is required")
			return "", false
		}
		return viewID, true
	}
	view, err := p.fetchOrCreateSingletonView("", "admin", "", "Admin Dashboard", req.Caller.CallerID)
	if err != nil {
		p.log.Error("resolveViewID: " + err.Error())
		res.Error(500, "failed to load admin dashboard")
		return "", false
	}
	return view.ID, true
}

// loadViewWithPanels fetches one view by ID and verifies it belongs to the
// caller (same project_id for project/integration scopes; any admin-scope
// row is globally visible to any admin-page caller, who by definition
// already passed the route's global users.write permission gate).
// Writes a 404/500 to res and returns loaded=false on failure so callers
// can just `return` on a false result.
func (p *dashboardPlugin) loadViewWithPanels(viewID, projectID string, res *plugin.Response) (*dashboardView, bool) {
	result, err := p.db.Query(
		`SELECT id, project_id, scope, host_view_id, name, created_at, updated_at
		 FROM dashboard_views WHERE id = $1`,
		viewID,
	)
	if err != nil {
		p.log.Error("loadViewWithPanels: " + err.Error())
		res.Error(500, "failed to load dashboard view")
		return nil, false
	}
	if len(result.Rows) == 0 {
		res.Error(404, "dashboard view not found")
		return nil, false
	}
	v := viewFromRow(result.Columns, result.Rows[0])

	// Ownership check: an admin-scope row (project_id nil) is fine for any
	// caller reaching an admin route (projectID == ""); a project/
	// integration-scope row must match the caller's own project.
	if v.Scope == "admin" {
		if projectID != "" {
			res.Error(404, "dashboard view not found")
			return nil, false
		}
	} else if v.ProjectID == nil || *v.ProjectID != projectID {
		res.Error(404, "dashboard view not found")
		return nil, false
	}

	panels, err := p.fetchPanelsForView(v.ID)
	if err != nil {
		p.log.Error("loadViewWithPanels panels: " + err.Error())
		res.Error(500, "failed to load dashboard view")
		return nil, false
	}
	v.Panels = panels
	return &v, true
}

func viewFromRow(cols []string, row []any) dashboardView {
	sc := newRowScanner(cols, row)
	return dashboardView{
		ID:         sc.str("id"),
		ProjectID:  sc.strPtr("project_id"),
		Scope:      sc.str("scope"),
		HostViewID: sc.strPtr("host_view_id"),
		Name:       sc.str("name"),
		CreatedAt:  sc.str("created_at"),
		UpdatedAt:  sc.str("updated_at"),
	}
}
