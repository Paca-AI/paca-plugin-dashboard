// Package main implements the com.paca.dashboard backend WASM plugin.
//
// It provides read-only aggregation routes for a project dashboard (task
// status breakdown, sprint burndown/story points, assignee workload) and a
// cross-project instance overview for the admin page. It owns no tables of
// its own — every route computes aggregates on demand from the host's core
// schema (projects, tasks, task_statuses, sprints, project_members, users),
// so there is nothing to migrate and nothing to cascade-delete on
// task/project removal.
package main

import (
	plugin "github.com/Paca-AI/plugin-sdk-go"
)

// dashboardPlugin implements plugin.Plugin.
type dashboardPlugin struct {
	db  *plugin.DB
	log *plugin.Logger
}

// Init registers all routes on the provided context.
func (p *dashboardPlugin) Init(ctx *plugin.Context) error {
	p.db = ctx.DB()
	p.log = ctx.Log()

	// Registered relative to the project prefix -- the host strips a leading
	// "/projects/:projectId" segment before matching (see plugin-sdk-go's
	// splitProjectPath/matchRoute), so this also matches the full path
	// "/projects/:projectId/dashboard/overview" declared in plugin.json.
	ctx.Route("GET", "/dashboard/overview", p.projectOverview)
	// Global/admin-scoped: no project prefix at all.
	ctx.Route("GET", "/dashboard/overview-all", p.instanceOverview)

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
