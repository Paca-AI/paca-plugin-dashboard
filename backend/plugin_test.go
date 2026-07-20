// plugin_test.go — unit tests for the customizable panel-based dashboard
// builder across the project/admin/integration scopes.
package main

import (
	"encoding/json"
	"testing"

	plugin "github.com/Paca-AI/plugin-sdk-go"
	"github.com/Paca-AI/plugin-sdk-go/plugintest"
)

// ── Helpers ───────────────────────────────────────────────────────────────────

const testProjectID = "project-1"

func setupPlugin(t *testing.T) *plugintest.Context {
	t.Helper()
	tc := plugintest.NewContext(t)

	tc.DB.SeedRows("dashboard_views",
		[]string{"id", "project_id", "scope", "host_view_id", "name", "created_by", "created_at", "updated_at"},
		nil)
	tc.DB.SeedRows("dashboard_panels",
		[]string{"id", "dashboard_view_id", "type", "title", "query", "chart_type", "content", "viz_config", "pos_x", "pos_y", "width", "height", "created_by", "created_at", "updated_at"},
		nil)
	// Seed a couple of whitelisted tables so guarded-query tests have
	// something real to select from.
	tc.DB.SeedRows("tasks", []string{"id", "project_id", "title"}, [][]any{
		{"task-1", testProjectID, "First task"},
		{"task-2", testProjectID, "Second task"},
		{"task-3", "other-project", "Someone else's task"},
	})

	var p dashboardPlugin
	if err := p.Init(tc.PluginContext()); err != nil {
		t.Fatal("Init failed:", err)
	}
	return tc
}

func callerReq() plugintest.Request {
	return plugintest.Request{
		Caller: plugin.CallerIdentity{
			ProjectID:  testProjectID,
			CallerID:   "member-1",
			CallerRole: "PROJECT_MEMBER",
		},
		PathParams: map[string]string{},
	}
}

// adminReq mirrors what the host actually sends for scope="global" routes:
// CallerID is always "" because the host only resolves a project_member (and
// thus a CallerID) for routes whose manifest declares scope="project" — see
// projectMemberParam in the API's plugin_handler.go. Admin routes have no
// :projectId to resolve against, so this must stay "" here rather than a
// fake id, or tests won't exercise the same empty-CallerID path production
// hits on every admin-view/admin-panel request.
func adminReq() plugintest.Request {
	return plugintest.Request{
		Caller: plugin.CallerIdentity{
			ProjectID:  "",
			CallerID:   "",
			CallerRole: "INSTANCE_ADMIN",
		},
		PathParams: map[string]string{},
	}
}

func withPathParams(req plugintest.Request, params map[string]string) plugintest.Request {
	m := make(map[string]string, len(req.PathParams)+len(params))
	for k, v := range req.PathParams {
		m[k] = v
	}
	for k, v := range params {
		m[k] = v
	}
	req.PathParams = m
	return req
}

func decodeData[T any](t *testing.T, res *plugin.Response) T {
	t.Helper()
	var env struct {
		Data T `json:"data"`
	}
	if err := json.Unmarshal(res.Body, &env); err != nil {
		t.Fatalf("failed to decode response body %s: %v", res.BodyString(), err)
	}
	return env.Data
}

// ── Project-scope singleton dashboard ────────────────────────────────────────

func TestGetOrCreateProjectView_CreatesOnFirstVisit(t *testing.T) {
	tc := setupPlugin(t)

	res := tc.Call("GET", "/dashboard/view", callerReq())
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, res.BodyString())
	}
	view := decodeData[dashboardView](t, res)
	if view.Scope != "project" {
		t.Fatalf("expected scope=project, got %q", view.Scope)
	}
	if view.ProjectID == nil || *view.ProjectID != testProjectID {
		t.Fatalf("expected project_id=%s, got %+v", testProjectID, view.ProjectID)
	}
	if len(view.Panels) != 0 {
		t.Fatalf("expected no panels on a fresh dashboard, got %+v", view.Panels)
	}
}

func TestGetOrCreateProjectView_IsIdempotent(t *testing.T) {
	tc := setupPlugin(t)

	first := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view", callerReq()))
	second := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view", callerReq()))

	if first.ID != second.ID {
		t.Fatalf("expected the same singleton dashboard id across calls, got %s vs %s", first.ID, second.ID)
	}
}

// ── Admin-scope singleton dashboard ──────────────────────────────────────────

func TestGetOrCreateAdminView_HasNoProjectID(t *testing.T) {
	tc := setupPlugin(t)

	res := tc.Call("GET", "/dashboard/admin-view", adminReq())
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, res.BodyString())
	}
	view := decodeData[dashboardView](t, res)
	if view.Scope != "admin" {
		t.Fatalf("expected scope=admin, got %q", view.Scope)
	}
	if view.ProjectID != nil {
		t.Fatalf("expected nil project_id for admin dashboard, got %+v", view.ProjectID)
	}
}

// TestGetOrCreateAdminView_EmptyCallerIDStoresNullCreatedBy guards against a
// regression where an empty req.Caller.CallerID (always the case for this
// route — see adminReq) was passed straight through as the created_by UUID
// param instead of being converted to NULL, which fails against real
// Postgres with "invalid input syntax for type uuid: \"\"" (SQLSTATE 22P02)
// even though plugintest's InMemoryDB doesn't type-check columns and so
// can't catch that failure mode itself.
func TestGetOrCreateAdminView_EmptyCallerIDStoresNullCreatedBy(t *testing.T) {
	tc := setupPlugin(t)

	res := tc.Call("GET", "/dashboard/admin-view", adminReq())
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, res.BodyString())
	}

	rows := tc.DB.AllRows("dashboard_views")
	if len(rows) != 1 {
		t.Fatalf("expected exactly 1 dashboard_views row, got %d", len(rows))
	}
	// Columns seeded as: id, project_id, scope, host_view_id, name, created_by, created_at, updated_at.
	createdBy := rows[0][5]
	if createdBy != nil {
		t.Fatalf("expected created_by to be stored as NULL for an empty CallerID, got %#v", createdBy)
	}
}

// ── Integration scope: one singleton dashboard per host view ────────────────

const testHostViewID = "host-view-1"

func TestGetOrCreateIntegrationView_CreatesOnFirstVisit(t *testing.T) {
	tc := setupPlugin(t)

	res := tc.Call("GET", "/dashboard/view/:hostViewId",
		withPathParams(callerReq(), map[string]string{"hostViewId": testHostViewID}))
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, res.BodyString())
	}
	view := decodeData[dashboardView](t, res)
	if view.Scope != "integration" {
		t.Fatalf("expected scope=integration, got %q", view.Scope)
	}
	if view.HostViewID == nil || *view.HostViewID != testHostViewID {
		t.Fatalf("expected host_view_id=%s, got %+v", testHostViewID, view.HostViewID)
	}
	if view.ProjectID == nil || *view.ProjectID != testProjectID {
		t.Fatalf("expected project_id=%s, got %+v", testProjectID, view.ProjectID)
	}
	if len(view.Panels) != 0 {
		t.Fatalf("expected no panels on a fresh dashboard, got %+v", view.Panels)
	}
}

func TestGetOrCreateIntegrationView_IsIdempotentPerHostView(t *testing.T) {
	tc := setupPlugin(t)

	first := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view/:hostViewId",
		withPathParams(callerReq(), map[string]string{"hostViewId": testHostViewID})))
	second := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view/:hostViewId",
		withPathParams(callerReq(), map[string]string{"hostViewId": testHostViewID})))

	if first.ID != second.ID {
		t.Fatalf("expected the same singleton dashboard id for the same host view, got %s vs %s", first.ID, second.ID)
	}
}

func TestGetOrCreateIntegrationView_DifferentHostViewsGetDifferentDashboards(t *testing.T) {
	tc := setupPlugin(t)

	a := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view/:hostViewId",
		withPathParams(callerReq(), map[string]string{"hostViewId": "host-view-a"})))
	b := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view/:hostViewId",
		withPathParams(callerReq(), map[string]string{"hostViewId": "host-view-b"})))

	if a.ID == b.ID {
		t.Fatalf("expected distinct dashboards for distinct host views, both resolved to %s", a.ID)
	}
}

func TestGetOrCreateIntegrationView_MissingHostViewIdRejected(t *testing.T) {
	tc := setupPlugin(t)

	res := tc.Call("GET", "/dashboard/view/:hostViewId", callerReq())
	if res.StatusCode != 400 {
		t.Fatalf("expected 400, got %d: %s", res.StatusCode, res.BodyString())
	}
}

func TestGetView_UnknownID(t *testing.T) {
	tc := setupPlugin(t)

	res := tc.Call("GET", "/dashboard/views/:viewId",
		withPathParams(callerReq(), map[string]string{"viewId": "nonexistent"}))
	if res.StatusCode != 404 {
		t.Fatalf("expected 404, got %d", res.StatusCode)
	}
}

func TestGetView_CrossProjectRejected(t *testing.T) {
	tc := setupPlugin(t)

	created := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view/:hostViewId",
		withPathParams(callerReq(), map[string]string{"hostViewId": testHostViewID})))

	otherProjectReq := plugintest.Request{
		Caller: plugin.CallerIdentity{ProjectID: "project-2", CallerID: "member-2", CallerRole: "PROJECT_MEMBER"},
	}
	res := tc.Call("GET", "/dashboard/views/:viewId",
		withPathParams(otherProjectReq, map[string]string{"viewId": created.ID}))
	if res.StatusCode != 404 {
		t.Fatalf("expected 404 (view belongs to a different project), got %d: %s", res.StatusCode, res.BodyString())
	}
}

// ── Panel CRUD ────────────────────────────────────────────────────────────────

func TestCreateTextPanel(t *testing.T) {
	tc := setupPlugin(t)
	view := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view", callerReq()))

	res := tc.Call("POST", "/dashboard/views/:viewId/panels",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID}).
			WithJSONBody(map[string]any{
				"type":    "text",
				"title":   "Notes",
				"content": "## Sprint notes\n\nEverything is on track.",
			}))
	if res.StatusCode != 201 {
		t.Fatalf("expected 201, got %d: %s", res.StatusCode, res.BodyString())
	}
	panel := decodeData[dashboardPanel](t, res)
	if panel.Type != "text" || panel.Content == nil || *panel.Content == "" {
		t.Fatalf("unexpected panel: %+v", panel)
	}
}

func TestCreatePanel_RejectsMissingChartType(t *testing.T) {
	tc := setupPlugin(t)
	view := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view", callerReq()))

	res := tc.Call("POST", "/dashboard/views/:viewId/panels",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID}).
			WithJSONBody(map[string]any{
				"type":  "chart",
				"title": "Missing chart type",
				"query": "SELECT id FROM tasks WHERE project_id = {{project_id}}",
			}))
	if res.StatusCode != 400 {
		t.Fatalf("expected 400, got %d: %s", res.StatusCode, res.BodyString())
	}
}

func TestCreatePanel_RejectsUnguardedQuery(t *testing.T) {
	tc := setupPlugin(t)
	view := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view", callerReq()))

	res := tc.Call("POST", "/dashboard/views/:viewId/panels",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID}).
			WithJSONBody(map[string]any{
				"type":  "table",
				"title": "Unscoped",
				"query": "SELECT id, title FROM tasks", // no {{project_id}} placeholder
			}))
	if res.StatusCode != 400 {
		t.Fatalf("expected 400 (query must be project-scoped), got %d: %s", res.StatusCode, res.BodyString())
	}
}

func TestCreateAndUpdatePanel_Layout(t *testing.T) {
	tc := setupPlugin(t)
	view := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view", callerReq()))

	created := decodeData[dashboardPanel](t, tc.Call("POST", "/dashboard/views/:viewId/panels",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID}).
			WithJSONBody(map[string]any{
				"type":  "table",
				"title": "Task list",
				"query": "SELECT id, title FROM tasks WHERE project_id = {{project_id}}",
			})))

	layoutRes := tc.Call("PATCH", "/dashboard/views/:viewId/panels/layout",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID}).
			WithJSONBody(map[string]any{
				"panels": []map[string]any{
					{"id": created.ID, "pos_x": 4, "pos_y": 8, "width": 6, "height": 5},
				},
			}))
	if layoutRes.StatusCode != 204 {
		t.Fatalf("expected 204, got %d: %s", layoutRes.StatusCode, layoutRes.BodyString())
	}

	reloaded := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/views/:viewId",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID})))
	if len(reloaded.Panels) != 1 || reloaded.Panels[0].PosX != 4 || reloaded.Panels[0].Width != 6 {
		t.Fatalf("expected updated layout to persist, got %+v", reloaded.Panels)
	}
}

func TestDeletePanel(t *testing.T) {
	tc := setupPlugin(t)
	view := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view", callerReq()))

	created := decodeData[dashboardPanel](t, tc.Call("POST", "/dashboard/views/:viewId/panels",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID}).
			WithJSONBody(map[string]any{"type": "text", "title": "Temp", "content": "x"})))

	delRes := tc.Call("DELETE", "/dashboard/views/:viewId/panels/:panelId",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID, "panelId": created.ID}))
	if delRes.StatusCode != 204 {
		t.Fatalf("expected 204, got %d: %s", delRes.StatusCode, delRes.BodyString())
	}
}

// ── Admin-scope panel CRUD ───────────────────────────────────────────────────
//
// Unlike the project-scope routes above, none of these carry a :viewId path
// segment (see resolveViewID in views.go) — the admin dashboard is a global
// singleton addressed by /dashboard/admin-view alone. These regression-test
// the fix for a bug where the handlers blindly read req.PathParam("viewId"),
// got "" back, and blew up downstream trying to use it as a UUID query param.

func TestCreateAdminPanel(t *testing.T) {
	tc := setupPlugin(t)

	res := tc.Call("POST", "/dashboard/admin-view/panels",
		adminReq().WithJSONBody(map[string]any{
			"type":    "text",
			"title":   "Notes",
			"content": "Instance-wide notes.",
		}))
	if res.StatusCode != 201 {
		t.Fatalf("expected 201, got %d: %s", res.StatusCode, res.BodyString())
	}
	panel := decodeData[dashboardPanel](t, res)
	if panel.Type != "text" || panel.Content == nil || *panel.Content == "" {
		t.Fatalf("unexpected panel: %+v", panel)
	}

	view := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/admin-view", adminReq()))
	if len(view.Panels) != 1 || view.Panels[0].ID != panel.ID {
		t.Fatalf("expected the new panel to show up on the admin singleton, got %+v", view.Panels)
	}
}

func TestUpdateAdminPanel(t *testing.T) {
	tc := setupPlugin(t)

	created := decodeData[dashboardPanel](t, tc.Call("POST", "/dashboard/admin-view/panels",
		adminReq().WithJSONBody(map[string]any{"type": "text", "title": "Original", "content": "x"})))

	res := tc.Call("PATCH", "/dashboard/admin-view/panels/:panelId",
		withPathParams(adminReq(), map[string]string{"panelId": created.ID}).
			WithJSONBody(map[string]any{"type": "text", "title": "Renamed", "content": "y"}))
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, res.BodyString())
	}
	updated := decodeData[dashboardPanel](t, res)
	if updated.Title != "Renamed" {
		t.Fatalf("expected title to be updated, got %+v", updated)
	}
}

func TestDeleteAdminPanel(t *testing.T) {
	tc := setupPlugin(t)

	created := decodeData[dashboardPanel](t, tc.Call("POST", "/dashboard/admin-view/panels",
		adminReq().WithJSONBody(map[string]any{"type": "text", "title": "Temp", "content": "x"})))

	res := tc.Call("DELETE", "/dashboard/admin-view/panels/:panelId",
		withPathParams(adminReq(), map[string]string{"panelId": created.ID}))
	if res.StatusCode != 204 {
		t.Fatalf("expected 204, got %d: %s", res.StatusCode, res.BodyString())
	}
}

func TestUpdateAdminPanelLayout(t *testing.T) {
	tc := setupPlugin(t)

	created := decodeData[dashboardPanel](t, tc.Call("POST", "/dashboard/admin-view/panels",
		adminReq().WithJSONBody(map[string]any{"type": "text", "title": "Notes", "content": "x"})))

	res := tc.Call("PATCH", "/dashboard/admin-view/panels/layout",
		adminReq().WithJSONBody(map[string]any{
			"panels": []map[string]any{
				{"id": created.ID, "pos_x": 2, "pos_y": 3, "width": 5, "height": 4},
			},
		}))
	if res.StatusCode != 204 {
		t.Fatalf("expected 204, got %d: %s", res.StatusCode, res.BodyString())
	}

	view := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/admin-view", adminReq()))
	if len(view.Panels) != 1 || view.Panels[0].PosX != 2 || view.Panels[0].Width != 5 {
		t.Fatalf("expected updated layout to persist, got %+v", view.Panels)
	}
}

func TestRunAdminPanelQuery(t *testing.T) {
	tc := setupPlugin(t)

	panel := decodeData[dashboardPanel](t, tc.Call("POST", "/dashboard/admin-view/panels",
		adminReq().WithJSONBody(map[string]any{
			"type":  "table",
			"title": "All tasks",
			"query": "SELECT id, project_id, title FROM tasks",
		})))

	res := tc.Call("POST", "/dashboard/admin-view/panels/:panelId/data",
		withPathParams(adminReq(), map[string]string{"panelId": panel.ID}))
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, res.BodyString())
	}
	var env struct {
		Data struct {
			Rows []map[string]any `json:"rows"`
		} `json:"data"`
	}
	if err := json.Unmarshal(res.Body, &env); err != nil {
		t.Fatal(err)
	}
	if len(env.Data.Rows) != 3 {
		t.Fatalf("expected all 3 seeded tasks across projects for an admin-scope query, got %d: %+v", len(env.Data.Rows), env.Data.Rows)
	}
}

// ── Guarded query execution ───────────────────────────────────────────────────

func TestRunPanelQuery_ScopesToOwnProject(t *testing.T) {
	tc := setupPlugin(t)
	view := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view", callerReq()))

	panel := decodeData[dashboardPanel](t, tc.Call("POST", "/dashboard/views/:viewId/panels",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID}).
			WithJSONBody(map[string]any{
				"type":  "table",
				"title": "My tasks",
				"query": "SELECT id, title FROM tasks WHERE project_id = {{project_id}}",
			})))

	dataRes := tc.Call("POST", "/dashboard/views/:viewId/panels/:panelId/data",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID, "panelId": panel.ID}))
	if dataRes.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", dataRes.StatusCode, dataRes.BodyString())
	}
	var env struct {
		Data struct {
			Rows []map[string]any `json:"rows"`
		} `json:"data"`
	}
	if err := json.Unmarshal(dataRes.Body, &env); err != nil {
		t.Fatal(err)
	}
	// Only the two rows seeded under testProjectID should come back — the
	// InMemoryDB's WHERE-matching plus our forced project_id binding
	// together confirm the cross-project row ("task-3") never leaks in.
	if len(env.Data.Rows) != 2 {
		t.Fatalf("expected 2 rows scoped to the caller's project, got %d: %+v", len(env.Data.Rows), env.Data.Rows)
	}
}

func TestPreviewQuery_RejectsForbiddenKeyword(t *testing.T) {
	tc := setupPlugin(t)

	res := tc.Call("POST", "/dashboard/query/preview",
		callerReq().WithJSONBody(map[string]string{
			"query": "SELECT id FROM tasks WHERE project_id = {{project_id}}; DROP TABLE tasks;",
		}))
	if res.StatusCode != 400 {
		t.Fatalf("expected 400, got %d: %s", res.StatusCode, res.BodyString())
	}
}

// TestPreviewQuery_NoLongerRestrictsTablesByWhitelist pins the removal of
// query_guard.go's old per-table read whitelist: a table that was never on
// it (unlike "tasks", seeded in setupPlugin) must still be reachable once
// it satisfies every other rule (single SELECT, project-scoped placeholder,
// no forbidden keywords). Which columns are sensitive is the host's job now
// (services/api/internal/platform/plugin/runtime.go's sensitiveFields/core
// registry), not something this plugin's own guard decides — that
// redaction isn't exercised by plugintest's InMemoryDB, so it's covered by
// the API's own test suite, not here.
func TestPreviewQuery_NoLongerRestrictsTablesByWhitelist(t *testing.T) {
	tc := setupPlugin(t)
	tc.DB.SeedRows("workflows", []string{"id", "project_id", "name"}, [][]any{
		{"workflow-1", testProjectID, "Some workflow"},
	})

	res := tc.Call("POST", "/dashboard/query/preview",
		callerReq().WithJSONBody(map[string]string{
			"query": "SELECT id, name FROM workflows WHERE project_id = {{project_id}}",
		}))
	if res.StatusCode != 200 {
		t.Fatalf("expected 200 (table-level whitelist no longer applies), got %d: %s", res.StatusCode, res.BodyString())
	}
}

func TestPreviewAdminQuery_AllowsCrossProjectNoPlaceholder(t *testing.T) {
	tc := setupPlugin(t)

	res := tc.Call("POST", "/dashboard/admin-query/preview",
		adminReq().WithJSONBody(map[string]string{
			"query": "SELECT id, project_id, title FROM tasks",
		}))
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, res.BodyString())
	}
	var env struct {
		Data struct {
			Rows []map[string]any `json:"rows"`
		} `json:"data"`
	}
	_ = json.Unmarshal(res.Body, &env)
	if len(env.Data.Rows) != 3 {
		t.Fatalf("expected all 3 seeded tasks across projects for an admin-scope query, got %d", len(env.Data.Rows))
	}
}

// ── query_guard.go unit tests (no HTTP layer) ────────────────────────────────

func TestValidateQuery_RequiresProjectPlaceholder(t *testing.T) {
	if _, err := validateQuery("SELECT id FROM tasks", true); err == nil {
		t.Fatal("expected error for missing {{project_id}} placeholder")
	}
}

func TestValidateQuery_AppendsDefaultLimit(t *testing.T) {
	safe, err := validateQuery("SELECT id FROM tasks WHERE project_id = {{project_id}}", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !containsLimit(safe) {
		t.Fatalf("expected LIMIT to be appended, got %q", safe)
	}
}

func TestValidateQuery_RejectsMultipleStatements(t *testing.T) {
	if _, err := validateQuery("SELECT id FROM tasks WHERE project_id = {{project_id}}; SELECT 1;", true); err == nil {
		t.Fatal("expected error for multiple statements")
	}
}

func TestValidateQuery_RejectsDollarOneDirectUse(t *testing.T) {
	if _, err := validateQuery("SELECT id FROM tasks WHERE project_id = {{project_id}} AND id = $1", true); err == nil {
		t.Fatal("expected error: $1 is reserved for the injected project_id")
	}
}

func containsLimit(sql string) bool {
	return limitRe.MatchString(sql)
}
