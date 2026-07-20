// panels.go — dashboard_panels CRUD, layout updates, and guarded query
// execution for chart/table panels. Handlers are written once per
// (project, admin) scope pair since the SQL is nearly identical but the
// project_id binding and guard's requireProjectScope flag differ; the
// integration scope reuses the project-scope handlers since both are
// project-bound rows validated the same way via loadViewWithPanels.
package main

import (
	"encoding/json"
	"strings"

	plugin "github.com/Paca-AI/plugin-sdk-go"
)

var validPanelTypes = map[string]bool{"chart": true, "table": true, "text": true}
var validChartTypes = map[string]bool{"bar": true, "line": true, "donut": true}

type panelBody struct {
	Type      string          `json:"type"`
	Title     string          `json:"title"`
	Query     *string         `json:"query"`
	ChartType *string         `json:"chart_type"`
	Content   *string         `json:"content"`
	VizConfig json.RawMessage `json:"viz_config"`
	PosX      *int            `json:"pos_x"`
	PosY      *int            `json:"pos_y"`
	Width     *int            `json:"width"`
	Height    *int            `json:"height"`
}

// validate applies the shared cross-field rules for a panel create/update
// body: type must be one of chart/table/text, chart panels need a
// chart_type, chart/table panels need a non-empty query, text panels need
// content and must not carry a query.
func (b *panelBody) validate() error {
	if !validPanelTypes[b.Type] {
		return invalidQuery("type must be one of: chart, table, text")
	}
	switch b.Type {
	case "chart":
		if b.ChartType == nil || !validChartTypes[*b.ChartType] {
			return invalidQuery("chart panels require chart_type to be one of: bar, line, donut")
		}
		if b.Query == nil || strings.TrimSpace(*b.Query) == "" {
			return invalidQuery("chart panels require a non-empty query")
		}
	case "table":
		if b.Query == nil || strings.TrimSpace(*b.Query) == "" {
			return invalidQuery("table panels require a non-empty query")
		}
	case "text":
		if b.Content == nil {
			return invalidQuery("text panels require content")
		}
	}
	return nil
}

// ── Project/integration-scope panel routes ──────────────────────────────────

func (p *dashboardPlugin) createPanel(req *plugin.Request, res *plugin.Response) {
	p.createPanelForView(req, res, req.Caller.ProjectID)
}

func (p *dashboardPlugin) updatePanel(req *plugin.Request, res *plugin.Response) {
	p.updatePanelForView(req, res, req.Caller.ProjectID)
}

func (p *dashboardPlugin) deletePanel(req *plugin.Request, res *plugin.Response) {
	p.deletePanelForView(req, res, req.Caller.ProjectID)
}

func (p *dashboardPlugin) updatePanelLayout(req *plugin.Request, res *plugin.Response) {
	p.updatePanelLayoutForView(req, res, req.Caller.ProjectID)
}

func (p *dashboardPlugin) runPanelQuery(req *plugin.Request, res *plugin.Response) {
	p.runPanelQueryForView(req, res, req.Caller.ProjectID, true)
}

func (p *dashboardPlugin) previewProjectQuery(req *plugin.Request, res *plugin.Response) {
	p.previewQuery(req, res, true)
}

// ── Admin-scope panel routes (no :projectId, project_id is NULL) ───────────

func (p *dashboardPlugin) createAdminPanel(req *plugin.Request, res *plugin.Response) {
	p.createPanelForView(req, res, "")
}

func (p *dashboardPlugin) updateAdminPanel(req *plugin.Request, res *plugin.Response) {
	p.updatePanelForView(req, res, "")
}

func (p *dashboardPlugin) deleteAdminPanel(req *plugin.Request, res *plugin.Response) {
	p.deletePanelForView(req, res, "")
}

func (p *dashboardPlugin) updateAdminPanelLayout(req *plugin.Request, res *plugin.Response) {
	p.updatePanelLayoutForView(req, res, "")
}

func (p *dashboardPlugin) runAdminPanelQuery(req *plugin.Request, res *plugin.Response) {
	p.runPanelQueryForView(req, res, "", false)
}

func (p *dashboardPlugin) previewAdminQuery(req *plugin.Request, res *plugin.Response) {
	p.previewQuery(req, res, false)
}

// ── Shared implementations ───────────────────────────────────────────────────

// createPanelForView handles POST .../:viewId/panels for any scope.
// projectID is "" for the admin scope's route (no :projectId in the path).
func (p *dashboardPlugin) createPanelForView(req *plugin.Request, res *plugin.Response, projectID string) {
	viewID, viewOK := p.resolveViewID(req, projectID, res)
	if !viewOK {
		return
	}
	view, loaded := p.loadViewWithPanels(viewID, projectID, res)
	if !loaded {
		return
	}

	b, err := plugin.JSONBody[panelBody](req)
	if err != nil {
		res.Error(400, "invalid request body")
		return
	}
	if err := b.validate(); err != nil {
		res.Error(400, err.Error())
		return
	}

	if b.Query != nil {
		if _, err := validateQuery(*b.Query, view.Scope != "admin"); err != nil {
			res.Error(400, err.Error())
			return
		}
	}

	vizConfig := "{}"
	if len(b.VizConfig) > 0 {
		vizConfig = string(b.VizConfig)
	}
	posX, posY, width, height := intOr(b.PosX, 0), intOr(b.PosY, 0), intOr(b.Width, 4), intOr(b.Height, 3)

	inserted, err := p.db.Query(
		`INSERT INTO dashboard_panels
		 (dashboard_view_id, type, title, query, chart_type, content, viz_config, pos_x, pos_y, width, height, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		 RETURNING id, dashboard_view_id, type, title, query, chart_type, content, viz_config, pos_x, pos_y, width, height, created_at, updated_at`,
		viewID, b.Type, b.Title, b.Query, b.ChartType, b.Content, vizConfig, posX, posY, width, height, nullableUUID(req.Caller.CallerID),
	)
	if err != nil || len(inserted.Rows) == 0 {
		if err != nil {
			p.log.Error("createPanelForView: " + err.Error())
		}
		res.Error(500, "failed to create panel")
		return
	}
	created(res, panelFromRow(inserted.Columns, inserted.Rows[0]))
}

// updatePanelForView handles PATCH .../:viewId/panels/:panelId.
func (p *dashboardPlugin) updatePanelForView(req *plugin.Request, res *plugin.Response, projectID string) {
	viewID, viewOK := p.resolveViewID(req, projectID, res)
	if !viewOK {
		return
	}
	panelID := req.PathParam("panelId")
	view, loaded := p.loadViewWithPanels(viewID, projectID, res)
	if !loaded {
		return
	}
	if !p.panelBelongsToView(panelID, viewID, res) {
		return
	}

	b, err := plugin.JSONBody[panelBody](req)
	if err != nil {
		res.Error(400, "invalid request body")
		return
	}
	if err := b.validate(); err != nil {
		res.Error(400, err.Error())
		return
	}
	if b.Query != nil {
		if _, err := validateQuery(*b.Query, view.Scope != "admin"); err != nil {
			res.Error(400, err.Error())
			return
		}
	}

	vizConfig := "{}"
	if len(b.VizConfig) > 0 {
		vizConfig = string(b.VizConfig)
	}

	affected, err := p.db.Exec(
		`UPDATE dashboard_panels
		 SET type = $1, title = $2, query = $3, chart_type = $4, content = $5,
		     viz_config = $6, updated_at = $7
		 WHERE id = $8 AND dashboard_view_id = $9`,
		b.Type, b.Title, b.Query, b.ChartType, b.Content, vizConfig, nowStr(), panelID, viewID,
	)
	if err != nil {
		p.log.Error("updatePanelForView: " + err.Error())
		res.Error(500, "failed to update panel")
		return
	}
	if affected == 0 {
		res.Error(404, "panel not found")
		return
	}

	result, err := p.db.Query(
		`SELECT id, dashboard_view_id, type, title, query, chart_type, content, viz_config, pos_x, pos_y, width, height, created_at, updated_at
		 FROM dashboard_panels WHERE id = $1`,
		panelID,
	)
	if err != nil || len(result.Rows) == 0 {
		res.Error(500, "failed to reload panel after update")
		return
	}
	ok(res, panelFromRow(result.Columns, result.Rows[0]))
}

// deletePanelForView handles DELETE .../:viewId/panels/:panelId.
func (p *dashboardPlugin) deletePanelForView(req *plugin.Request, res *plugin.Response, projectID string) {
	viewID, viewOK := p.resolveViewID(req, projectID, res)
	if !viewOK {
		return
	}
	panelID := req.PathParam("panelId")
	if _, ok2 := p.loadViewWithPanels(viewID, projectID, res); !ok2 {
		return
	}
	if !p.panelBelongsToView(panelID, viewID, res) {
		return
	}
	affected, err := p.db.Exec(`DELETE FROM dashboard_panels WHERE id = $1 AND dashboard_view_id = $2`, panelID, viewID)
	if err != nil {
		p.log.Error("deletePanelForView: " + err.Error())
		res.Error(500, "failed to delete panel")
		return
	}
	if affected == 0 {
		res.Error(404, "panel not found")
		return
	}
	res.NoContent()
}

// updatePanelLayoutForView handles PATCH .../:viewId/panels/layout — a bulk
// drag/resize commit from the frontend grid, one row per moved/resized
// panel. Each entry is validated to belong to the target view before any
// writes happen, so a malformed payload can't touch another view's panels.
func (p *dashboardPlugin) updatePanelLayoutForView(req *plugin.Request, res *plugin.Response, projectID string) {
	viewID, viewOK := p.resolveViewID(req, projectID, res)
	if !viewOK {
		return
	}
	if _, ok2 := p.loadViewWithPanels(viewID, projectID, res); !ok2 {
		return
	}

	type body struct {
		Panels []panelLayoutEntry `json:"panels"`
	}
	b, err := plugin.JSONBody[body](req)
	if err != nil {
		res.Error(400, "invalid request body")
		return
	}
	for _, entry := range b.Panels {
		if !p.panelBelongsToView(entry.ID, viewID, res) {
			return
		}
	}
	for _, entry := range b.Panels {
		if _, err := p.db.Exec(
			`UPDATE dashboard_panels SET pos_x = $1, pos_y = $2, width = $3, height = $4, updated_at = $5
			 WHERE id = $6 AND dashboard_view_id = $7`,
			entry.PosX, entry.PosY, entry.Width, entry.Height, nowStr(), entry.ID, viewID,
		); err != nil {
			p.log.Error("updatePanelLayoutForView: " + err.Error())
			res.Error(500, "failed to update panel layout")
			return
		}
	}
	res.NoContent()
}

// runPanelQueryForView handles POST .../:viewId/panels/:panelId/data —
// re-runs the panel's saved (already-guarded-at-save-time) query and
// returns fresh rows. requireProjectScope must match how the panel's query
// was originally validated (true for project/integration, false for admin)
// so the {{project_id}} placeholder is substituted consistently.
func (p *dashboardPlugin) runPanelQueryForView(req *plugin.Request, res *plugin.Response, projectID string, requireProjectScope bool) {
	viewID, viewOK := p.resolveViewID(req, projectID, res)
	if !viewOK {
		return
	}
	panelID := req.PathParam("panelId")
	if _, ok2 := p.loadViewWithPanels(viewID, projectID, res); !ok2 {
		return
	}

	result, err := p.db.Query(
		`SELECT query FROM dashboard_panels WHERE id = $1 AND dashboard_view_id = $2`,
		panelID, viewID,
	)
	if err != nil {
		p.log.Error("runPanelQueryForView fetch: " + err.Error())
		res.Error(500, "failed to run panel query")
		return
	}
	if len(result.Rows) == 0 {
		res.Error(404, "panel not found")
		return
	}
	sc := newRowScanner(result.Columns, result.Rows[0])
	rawQuery := sc.str("query")
	if rawQuery == "" {
		res.Error(400, "this panel has no query (text panels have no data to run)")
		return
	}

	p.executeGuardedQuery(res, rawQuery, projectID, requireProjectScope)
}

// previewQuery handles POST /dashboard/query/preview (and the admin
// equivalent) — validates and runs a not-yet-saved query so the panel
// editor can show a live preview before the user hits Save.
func (p *dashboardPlugin) previewQuery(req *plugin.Request, res *plugin.Response, requireProjectScope bool) {
	type body struct {
		Query string `json:"query"`
	}
	b, err := plugin.JSONBody[body](req)
	if err != nil {
		res.Error(400, "invalid request body")
		return
	}
	p.executeGuardedQuery(res, b.Query, req.Caller.ProjectID, requireProjectScope)
}

// executeGuardedQuery runs validateQuery (see query_guard.go for the full
// safety model) and, on success, executes the rewritten SQL with the
// caller's project_id bound as $1 for project/integration-scoped queries.
func (p *dashboardPlugin) executeGuardedQuery(res *plugin.Response, rawQuery, projectID string, requireProjectScope bool) {
	safeQuery, err := validateQuery(rawQuery, requireProjectScope)
	if err != nil {
		res.Error(400, err.Error())
		return
	}

	var result *plugin.DBQueryResult
	if requireProjectScope {
		result, err = p.db.Query(safeQuery, projectID)
	} else {
		result, err = p.db.Query(safeQuery)
	}
	if err != nil {
		p.log.Error("executeGuardedQuery: " + err.Error())
		res.Error(400, "query failed: "+err.Error())
		return
	}

	rows := make([]map[string]any, 0, len(result.Rows))
	for _, row := range result.Rows {
		r := make(map[string]any, len(result.Columns))
		for i, col := range result.Columns {
			if i < len(row) {
				r[col] = row[i]
			}
		}
		rows = append(rows, r)
	}
	// A zero-row result comes back from p.db.Query as a zero-value
	// DBQueryResult{} (see plugin-sdk-go's wasmDBBackend.Query), whose
	// Columns field is a nil slice — encoding/json marshals that as `null`,
	// not `[]`, which crashes every frontend consumer that assumes
	// QueryResult.columns is always an array (chart renderers, table view).
	columns := result.Columns
	if columns == nil {
		columns = []string{}
	}
	ok(res, map[string]any{"columns": columns, "rows": rows})
}

// panelBelongsToView verifies a panel is owned by the given view, writing
// a 404 and returning false otherwise.
func (p *dashboardPlugin) panelBelongsToView(panelID, viewID string, res *plugin.Response) bool {
	result, err := p.db.Query(
		`SELECT id FROM dashboard_panels WHERE id = $1 AND dashboard_view_id = $2`,
		panelID, viewID,
	)
	if err != nil {
		p.log.Error("panelBelongsToView: " + err.Error())
		res.Error(500, "internal error")
		return false
	}
	if len(result.Rows) == 0 {
		res.Error(404, "panel not found")
		return false
	}
	return true
}

// fetchPanelsForView returns all panels for a view ordered by creation
// time (stable insertion order; the frontend grid arranges by pos_x/pos_y
// after mount, but the initial JSON order should still be stable and
// predictable rather than PG's undefined default order).
func (p *dashboardPlugin) fetchPanelsForView(viewID string) ([]dashboardPanel, error) {
	result, err := p.db.Query(
		`SELECT id, dashboard_view_id, type, title, query, chart_type, content, viz_config, pos_x, pos_y, width, height, created_at, updated_at
		 FROM dashboard_panels WHERE dashboard_view_id = $1 ORDER BY created_at ASC`,
		viewID,
	)
	if err != nil {
		return nil, err
	}
	panels := make([]dashboardPanel, 0, len(result.Rows))
	for _, row := range result.Rows {
		panels = append(panels, panelFromRow(result.Columns, row))
	}
	return panels, nil
}

func panelFromRow(cols []string, row []any) dashboardPanel {
	sc := newRowScanner(cols, row)
	return dashboardPanel{
		ID:          sc.str("id"),
		DashboardID: sc.str("dashboard_view_id"),
		Type:        sc.str("type"),
		Title:       sc.str("title"),
		Query:       sc.strPtr("query"),
		ChartType:   sc.strPtr("chart_type"),
		Content:     sc.strPtr("content"),
		VizConfig:   sc.objVal("viz_config"),
		PosX:        sc.intVal("pos_x"),
		PosY:        sc.intVal("pos_y"),
		Width:       sc.intVal("width"),
		Height:      sc.intVal("height"),
		CreatedAt:   sc.str("created_at"),
		UpdatedAt:   sc.str("updated_at"),
	}
}

func intOr(v *int, def int) int {
	if v == nil {
		return def
	}
	return *v
}
