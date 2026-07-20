package main

import "fmt"

// ── Domain types ──────────────────────────────────────────────────────────────

// dashboardPanel is one chart/table/text panel within a dashboard view.
type dashboardPanel struct {
	ID          string         `json:"id"`
	DashboardID string         `json:"dashboard_view_id"`
	Type        string         `json:"type"` // "chart" | "table" | "text"
	Title       string         `json:"title"`
	Query       *string        `json:"query,omitempty"`      // chart/table only
	ChartType   *string        `json:"chart_type,omitempty"` // chart only: "bar" | "line" | "donut"
	Content     *string        `json:"content,omitempty"`    // text only
	VizConfig   map[string]any `json:"viz_config"`
	PosX        int            `json:"pos_x"`
	PosY        int            `json:"pos_y"`
	Width       int            `json:"width"`
	Height      int            `json:"height"`
	CreatedAt   string         `json:"created_at"`
	UpdatedAt   string         `json:"updated_at"`
}

// dashboardView is one dashboard (project/admin/integration scope) with its
// panels embedded.
type dashboardView struct {
	ID         string           `json:"id"`
	ProjectID  *string          `json:"project_id,omitempty"`
	Scope      string           `json:"scope"` // "project" | "admin" | "integration"
	// HostViewID is set only for scope="integration": the id of the host's
	// own interaction-view row (a "Dashboard"-type view in Backlog/Sprint/
	// Timeline) this dashboard belongs to — exactly one dashboard per host
	// view, enforced by uq_dashboard_views_one_per_host_view.
	HostViewID *string          `json:"host_view_id,omitempty"`
	Name       string           `json:"name"`
	Panels     []dashboardPanel `json:"panels"`
	CreatedAt  string           `json:"created_at"`
	UpdatedAt  string           `json:"updated_at"`
}

// panelLayoutEntry is one row of a bulk drag/resize layout update.
type panelLayoutEntry struct {
	ID     string `json:"id"`
	PosX   int    `json:"pos_x"`
	PosY   int    `json:"pos_y"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// ── Row scanner helper ────────────────────────────────────────────────────────
// Mirrors the pattern used by the checklist and time-logging plugins: a tiny
// column-name-indexed accessor over a plugin.DBQueryResult row, since the
// host bridge returns rows as untyped []any rather than a typed scanner.

type scanner struct {
	idx map[string]int
	row []any
}

func newRowScanner(cols []string, row []any) *scanner {
	idx := make(map[string]int, len(cols))
	for i, c := range cols {
		idx[c] = i
	}
	return &scanner{idx: idx, row: row}
}

func (s *scanner) str(col string) string {
	i, ok := s.idx[col]
	if !ok || i >= len(s.row) || s.row[i] == nil {
		return ""
	}
	switch v := s.row[i].(type) {
	case string:
		return v
	case *string:
		if v == nil {
			return ""
		}
		return *v
	default:
		return fmt.Sprintf("%v", s.row[i])
	}
}

func (s *scanner) strPtr(col string) *string {
	i, ok := s.idx[col]
	if !ok || i >= len(s.row) || s.row[i] == nil {
		return nil
	}
	v := s.str(col)
	return &v
}

func (s *scanner) intVal(col string) int {
	i, ok := s.idx[col]
	if !ok || i >= len(s.row) || s.row[i] == nil {
		return 0
	}
	switch v := s.row[i].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	default:
		return 0
	}
}

func (s *scanner) objVal(col string) map[string]any {
	i, ok := s.idx[col]
	if !ok || i >= len(s.row) || s.row[i] == nil {
		return map[string]any{}
	}
	if v, ok := s.row[i].(map[string]any); ok {
		return v
	}
	return map[string]any{}
}
