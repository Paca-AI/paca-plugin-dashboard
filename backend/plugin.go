// Package main implements the com.paca.dashboard backend WASM plugin.
//
// It provides a fully customizable panel-based dashboard builder across
// three scopes:
//   - project     — exactly one dashboard per project (project.page)
//   - admin       — exactly one instance-wide dashboard (admin.page)
//   - integration — exactly one dashboard per host interaction-view id,
//     surfaced as a "Dashboard" option in the Integration pages'
//     (backlog/sprint/timeline) "Add view" popover via the host's `view`
//     extension point — get-or-create singleton keyed by the host's own
//     view id, same shape as the project/admin scopes.
//
// Each dashboard is a "dashboard_views" row holding an ordered list of
// "dashboard_panels" (chart, table, or text). Chart/table panels run a
// user-authored SQL query through the guardrails in query_guard.go before
// hitting the host's shared multi-tenant Postgres — see that file's doc
// comment for the exact safety model.
package main

import (
	"time"

	plugin "github.com/Paca-AI/plugin-sdk-go"
)

// nowStr returns the current UTC time as an RFC3339Nano string, used
// anywhere an updated_at/created_at needs to be bound as an explicit query
// parameter rather than relying on a SQL-side NOW() (which the in-memory
// test backend's minimal parser cannot evaluate).
func nowStr() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

// dashboardPlugin implements plugin.Plugin.
type dashboardPlugin struct {
	db    *plugin.DB
	cache *plugin.Cache
	log   *plugin.Logger
}

// Init registers all routes on the provided context.
func (p *dashboardPlugin) Init(ctx *plugin.Context) error {
	p.db = ctx.DB()
	p.cache = ctx.Cache()
	p.log = ctx.Log()

	// ── Project-scope dashboard (get-or-create singleton) ──────────────────
	ctx.Route("GET", "/dashboard/view", p.getOrCreateProjectView)

	// ── Admin-scope dashboard (get-or-create singleton, no :projectId) ─────
	ctx.Route("GET", "/dashboard/admin-view", p.getOrCreateAdminView)

	// ── Integration-scope dashboard (get-or-create singleton, one per host
	// interaction-view id — no more list/create/rename/delete: each
	// "Dashboard"-type view in Backlog/Sprint/Timeline gets exactly one
	// dashboard, resolved by the host's own view id) ────────────────────────
	ctx.Route("GET", "/dashboard/view/:hostViewId", p.getOrCreateIntegrationView)
	ctx.Route("GET", "/dashboard/views/:viewId", p.getView)

	// ── Panels (scoped under a resolved view ID, any scope) ────────────────
	ctx.Route("POST", "/dashboard/views/:viewId/panels", p.createPanel)
	ctx.Route("PATCH", "/dashboard/views/:viewId/panels/:panelId", p.updatePanel)
	ctx.Route("DELETE", "/dashboard/views/:viewId/panels/:panelId", p.deletePanel)
	ctx.Route("PATCH", "/dashboard/views/:viewId/panels/layout", p.updatePanelLayout)
	ctx.Route("POST", "/dashboard/views/:viewId/panels/:panelId/data", p.runPanelQuery)

	// ── Admin-scope panels (no :projectId prefix) ───────────────────────────
	ctx.Route("POST", "/dashboard/admin-view/panels", p.createAdminPanel)
	ctx.Route("PATCH", "/dashboard/admin-view/panels/:panelId", p.updateAdminPanel)
	ctx.Route("DELETE", "/dashboard/admin-view/panels/:panelId", p.deleteAdminPanel)
	ctx.Route("PATCH", "/dashboard/admin-view/panels/layout", p.updateAdminPanelLayout)
	ctx.Route("POST", "/dashboard/admin-view/panels/:panelId/data", p.runAdminPanelQuery)

	// ── Query preview (validate + run a not-yet-saved query) ────────────────
	ctx.Route("POST", "/dashboard/query/preview", p.previewProjectQuery)
	ctx.Route("POST", "/dashboard/admin-query/preview", p.previewAdminQuery)

	return nil
}

// Shutdown is a no-op for this plugin.
func (p *dashboardPlugin) Shutdown() {}

// envelope wraps successful API responses to match the host's standard format.
type envelope struct {
	Success bool `json:"success"`
	Data    any  `json:"data"`
}

func ok(res *plugin.Response, data any) {
	res.JSON(200, envelope{Success: true, Data: data})
}

func created(res *plugin.Response, data any) {
	res.JSON(201, envelope{Success: true, Data: data})
}

// nullableUUID converts an empty caller/UUID string into a SQL NULL param.
// req.Caller.CallerID is "" whenever the route's manifest declares
// scope="global" permissions instead of scope="project" — the host never
// resolves a project_member for those routes (there's no :projectId to
// resolve against), so passing it straight through as a UUID column value
// fails with "invalid input syntax for type uuid". created_by columns are
// nullable (ON DELETE SET NULL) precisely to allow this.
func nullableUUID(id string) any {
	if id == "" {
		return nil
	}
	return id
}
