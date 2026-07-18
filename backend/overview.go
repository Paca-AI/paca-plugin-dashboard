package main

import (
	"fmt"

	plugin "github.com/Paca-AI/plugin-sdk-go"
)

// ── Domain types ──────────────────────────────────────────────────────────────

// statusCount is one slice of the task-status breakdown donut/bar.
type statusCount struct {
	StatusID   string `json:"status_id"`
	StatusName string `json:"status_name"`
	Color      string `json:"color"`
	Category   string `json:"category"`
	Count      int    `json:"count"`
}

// sprintProgress summarizes the project's current active sprint (the first
// one found, by start_date, when a project runs more than one concurrently —
// see database-schema.md's note that multiple sprints may be active at once).
// Nil when no sprint has status = 'active'.
type sprintProgress struct {
	ID                string  `json:"id"`
	Name              string  `json:"name"`
	StartDate         string  `json:"start_date"`
	EndDate           string  `json:"end_date"`
	Goal              string  `json:"goal"`
	TotalTasks        int     `json:"total_tasks"`
	DoneTasks         int     `json:"done_tasks"`
	TotalStoryPoints  int     `json:"total_story_points"`
	DoneStoryPoints   int     `json:"done_story_points"`
	PercentTasksDone  float64 `json:"percent_tasks_done"`
	PercentPointsDone float64 `json:"percent_points_done"`
}

// workloadEntry is one project member's open (not-done-category) task count,
// used for the "assignee workload" bar chart.
type workloadEntry struct {
	MemberID       string `json:"member_id"`
	MemberName     string `json:"member_name"`
	OpenTaskCount  int    `json:"open_task_count"`
	TotalTaskCount int    `json:"total_task_count"`
}

// projectOverviewData is the full payload for GET
// /projects/:projectId/dashboard/overview.
type projectOverviewData struct {
	TotalTasks       int             `json:"total_tasks"`
	TotalStoryPoints int             `json:"total_story_points"`
	StatusBreakdown  []statusCount   `json:"status_breakdown"`
	ActiveSprint     *sprintProgress `json:"active_sprint"`
	Workload         []workloadEntry `json:"workload"`
}

// projectSummaryRow is one row of the cross-project admin overview table.
type projectSummaryRow struct {
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"project_name"`
	TotalTasks  int    `json:"total_tasks"`
	OpenTasks   int    `json:"open_tasks"`
	DoneTasks   int    `json:"done_tasks"`
}

// instanceOverviewData is the full payload for GET /dashboard/overview-all.
type instanceOverviewData struct {
	ProjectCount   int                 `json:"project_count"`
	TotalTasks     int                 `json:"total_tasks"`
	TotalOpenTasks int                 `json:"total_open_tasks"`
	Projects       []projectSummaryRow `json:"projects"`
}

// ── Row scanner helper ────────────────────────────────────────────────────────
// Mirrors the pattern used by the time-logging and checklist plugins: a tiny
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

// ── Route handlers ───────────────────────────────────────────────────────────

// projectOverview handles GET /projects/:projectId/dashboard/overview.
// Read-only aggregation across the host's core tables (tasks, task_statuses,
// sprints, task_assignees, project_members, users); the dashboard plugin
// owns no tables of its own.
func (p *dashboardPlugin) projectOverview(req *plugin.Request, res *plugin.Response) {
	projectID := req.Caller.ProjectID

	statusBreakdown, totalTasks, totalPoints, err := p.fetchStatusBreakdown(projectID)
	if err != nil {
		p.log.Error("projectOverview status breakdown: " + err.Error())
		res.Error(500, "failed to compute dashboard overview")
		return
	}

	activeSprint, err := p.fetchActiveSprintProgress(projectID)
	if err != nil {
		p.log.Error("projectOverview active sprint: " + err.Error())
		res.Error(500, "failed to compute dashboard overview")
		return
	}

	workload, err := p.fetchWorkload(projectID)
	if err != nil {
		p.log.Error("projectOverview workload: " + err.Error())
		res.Error(500, "failed to compute dashboard overview")
		return
	}

	ok(res, projectOverviewData{
		TotalTasks:       totalTasks,
		TotalStoryPoints: totalPoints,
		StatusBreakdown:  statusBreakdown,
		ActiveSprint:     activeSprint,
		Workload:         workload,
	})
}

// fetchStatusBreakdown returns one count per task_statuses row (including
// zero-count statuses, so the chart's legend/axis stays stable as tasks move
// between columns) plus the project's total task and story-point counts.
func (p *dashboardPlugin) fetchStatusBreakdown(projectID string) ([]statusCount, int, int, error) {
	result, err := p.db.Query(
		`SELECT ts.id AS status_id, ts.name AS status_name, ts.color, ts.category,
		        COUNT(t.id) AS task_count
		 FROM task_statuses ts
		 LEFT JOIN tasks t ON t.status_id = ts.id AND t.deleted_at IS NULL
		 WHERE ts.project_id = $1
		 GROUP BY ts.id, ts.name, ts.color, ts.category, ts.position
		 ORDER BY ts.position ASC`,
		projectID,
	)
	if err != nil {
		return nil, 0, 0, err
	}

	breakdown := make([]statusCount, 0, len(result.Rows))
	total := 0
	for _, row := range result.Rows {
		sc := newRowScanner(result.Columns, row)
		count := sc.intVal("task_count")
		total += count
		breakdown = append(breakdown, statusCount{
			StatusID:   sc.str("status_id"),
			StatusName: sc.str("status_name"),
			Color:      sc.str("color"),
			Category:   sc.str("category"),
			Count:      count,
		})
	}

	pointsResult, err := p.db.Query(
		`SELECT COALESCE(SUM(story_points), 0) AS total_points
		 FROM tasks WHERE project_id = $1 AND deleted_at IS NULL`,
		projectID,
	)
	if err != nil {
		return nil, 0, 0, err
	}
	totalPoints := 0
	if len(pointsResult.Rows) > 0 {
		totalPoints = newRowScanner(pointsResult.Columns, pointsResult.Rows[0]).intVal("total_points")
	}

	return breakdown, total, totalPoints, nil
}

// fetchActiveSprintProgress returns progress for the project's active sprint
// (status = 'active'), preferring the one with the earliest start_date when
// several are active at once. Returns nil (no error) when there is none.
func (p *dashboardPlugin) fetchActiveSprintProgress(projectID string) (*sprintProgress, error) {
	sprintResult, err := p.db.Query(
		`SELECT id, name, COALESCE(to_char(start_date, 'YYYY-MM-DD'), '') AS start_date,
		        COALESCE(to_char(end_date, 'YYYY-MM-DD'), '') AS end_date, COALESCE(goal, '') AS goal
		 FROM sprints
		 WHERE project_id = $1 AND status = 'active'
		 ORDER BY start_date ASC NULLS LAST
		 LIMIT 1`,
		projectID,
	)
	if err != nil {
		return nil, err
	}
	if len(sprintResult.Rows) == 0 {
		return nil, nil
	}
	sc := newRowScanner(sprintResult.Columns, sprintResult.Rows[0])
	sprintID := sc.str("id")

	taskResult, err := p.db.Query(
		`SELECT COUNT(*) AS total_tasks,
		        COUNT(*) FILTER (WHERE ts.category = 'done') AS done_tasks,
		        COALESCE(SUM(t.story_points), 0) AS total_points,
		        COALESCE(SUM(t.story_points) FILTER (WHERE ts.category = 'done'), 0) AS done_points
		 FROM tasks t
		 JOIN task_statuses ts ON ts.id = t.status_id
		 WHERE t.sprint_id = $1 AND t.deleted_at IS NULL`,
		sprintID,
	)
	if err != nil {
		return nil, err
	}

	progress := &sprintProgress{
		ID:        sprintID,
		Name:      sc.str("name"),
		StartDate: sc.str("start_date"),
		EndDate:   sc.str("end_date"),
		Goal:      sc.str("goal"),
	}
	if len(taskResult.Rows) > 0 {
		tsc := newRowScanner(taskResult.Columns, taskResult.Rows[0])
		progress.TotalTasks = tsc.intVal("total_tasks")
		progress.DoneTasks = tsc.intVal("done_tasks")
		progress.TotalStoryPoints = tsc.intVal("total_points")
		progress.DoneStoryPoints = tsc.intVal("done_points")
	}
	if progress.TotalTasks > 0 {
		progress.PercentTasksDone = round1(100 * float64(progress.DoneTasks) / float64(progress.TotalTasks))
	}
	if progress.TotalStoryPoints > 0 {
		progress.PercentPointsDone = round1(100 * float64(progress.DoneStoryPoints) / float64(progress.TotalStoryPoints))
	}
	return progress, nil
}

// fetchWorkload returns each project member's open (non-done-category) and
// total assigned task counts, most-loaded first. Members with zero assigned
// tasks are omitted so the chart doesn't grow unbounded with project size.
func (p *dashboardPlugin) fetchWorkload(projectID string) ([]workloadEntry, error) {
	result, err := p.db.Query(
		`SELECT pm.id AS member_id, COALESCE(u.full_name, u.username, '') AS member_name,
		        COUNT(*) AS total_task_count,
		        COUNT(*) FILTER (WHERE ts.category <> 'done') AS open_task_count
		 FROM task_assignees ta
		 JOIN project_members pm ON pm.id = ta.member_id
		 JOIN tasks t ON t.id = ta.task_id AND t.deleted_at IS NULL
		 JOIN task_statuses ts ON ts.id = t.status_id
		 LEFT JOIN users u ON u.id = pm.user_id
		 WHERE t.project_id = $1
		 GROUP BY pm.id, u.full_name, u.username
		 ORDER BY open_task_count DESC, total_task_count DESC`,
		projectID,
	)
	if err != nil {
		return nil, err
	}
	workload := make([]workloadEntry, 0, len(result.Rows))
	for _, row := range result.Rows {
		sc := newRowScanner(result.Columns, row)
		workload = append(workload, workloadEntry{
			MemberID:       sc.str("member_id"),
			MemberName:     sc.str("member_name"),
			OpenTaskCount:  sc.intVal("open_task_count"),
			TotalTaskCount: sc.intVal("total_task_count"),
		})
	}
	return workload, nil
}

// instanceOverview handles GET /dashboard/overview-all (global/admin scope).
// Gated by the built-in users.write permission at the route level (see
// plugin.json) — the same gate the host applies to its other admin pages —
// so no plugin-specific custom permission is needed here.
func (p *dashboardPlugin) instanceOverview(req *plugin.Request, res *plugin.Response) {
	result, err := p.db.Query(
		`SELECT pr.id AS project_id, pr.name AS project_name,
		        COUNT(t.id) AS total_tasks,
		        COUNT(t.id) FILTER (WHERE ts.category <> 'done') AS open_tasks,
		        COUNT(t.id) FILTER (WHERE ts.category = 'done') AS done_tasks
		 FROM projects pr
		 LEFT JOIN tasks t ON t.project_id = pr.id AND t.deleted_at IS NULL
		 LEFT JOIN task_statuses ts ON ts.id = t.status_id
		 GROUP BY pr.id, pr.name
		 ORDER BY pr.name ASC`,
	)
	if err != nil {
		p.log.Error("instanceOverview: " + err.Error())
		res.Error(500, "failed to compute instance overview")
		return
	}

	projects := make([]projectSummaryRow, 0, len(result.Rows))
	totalTasks, totalOpen := 0, 0
	for _, row := range result.Rows {
		sc := newRowScanner(result.Columns, row)
		total := sc.intVal("total_tasks")
		open := sc.intVal("open_tasks")
		totalTasks += total
		totalOpen += open
		projects = append(projects, projectSummaryRow{
			ProjectID:   sc.str("project_id"),
			ProjectName: sc.str("project_name"),
			TotalTasks:  total,
			OpenTasks:   open,
			DoneTasks:   sc.intVal("done_tasks"),
		})
	}

	ok(res, instanceOverviewData{
		ProjectCount:   len(projects),
		TotalTasks:     totalTasks,
		TotalOpenTasks: totalOpen,
		Projects:       projects,
	})
}

// round1 rounds a float64 to one decimal place, used for percentage fields.
func round1(f float64) float64 {
	return float64(int(f*10+0.5)) / 10
}
