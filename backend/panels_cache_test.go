// panels_cache_test.go — unit tests for the 5-minute Valkey-backed panel
// data cache added to runPanelQueryForView: a cache hit must keep serving
// the last-computed result even after the underlying data changes, a hit
// must stop once its TTL elapses, and editing or deleting a panel must
// invalidate its cached result immediately rather than waiting out the TTL.
package main

import (
	"encoding/json"
	"testing"
	"time"

	plugin "github.com/Paca-AI/plugin-sdk-go"
	"github.com/Paca-AI/plugin-sdk-go/plugintest"
)

func panelDataRows(t *testing.T, res *plugin.Response) []map[string]any {
	t.Helper()
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, res.BodyString())
	}
	var env struct {
		Data struct {
			Rows []map[string]any `json:"rows"`
		} `json:"data"`
	}
	if err := json.Unmarshal(res.Body, &env); err != nil {
		t.Fatalf("failed to decode response body %s: %v", res.BodyString(), err)
	}
	return env.Data.Rows
}

func createAllTasksAdminPanel(t *testing.T, tc *plugintest.Context) dashboardPanel {
	t.Helper()
	return decodeData[dashboardPanel](t, tc.Call("POST", "/dashboard/admin-view/panels",
		adminReq().WithJSONBody(map[string]any{
			"type":  "table",
			"title": "All tasks",
			"query": "SELECT id, project_id, title FROM tasks",
		})))
}

func TestRunPanelQuery_CachesResultAcrossCalls(t *testing.T) {
	tc := setupPlugin(t)
	panel := createAllTasksAdminPanel(t, tc)
	dataReq := withPathParams(adminReq(), map[string]string{"panelId": panel.ID})

	first := panelDataRows(t, tc.Call("POST", "/dashboard/admin-view/panels/:panelId/data", dataReq))
	if len(first) != 3 {
		t.Fatalf("expected 3 rows on first (uncached) run, got %d", len(first))
	}

	// Mutate the underlying table directly. A cache miss would pick this up
	// on the very next call; a hit should keep serving the 3-row snapshot
	// captured above.
	tc.DB.SeedRows("tasks", []string{"id", "project_id", "title"}, [][]any{
		{"task-1", testProjectID, "First task"},
	})

	second := panelDataRows(t, tc.Call("POST", "/dashboard/admin-view/panels/:panelId/data", dataReq))
	if len(second) != 3 {
		t.Fatalf("expected the cached 3-row result to still be served, got %d rows", len(second))
	}
}

func TestRunPanelQuery_CacheExpiresAfterTTL(t *testing.T) {
	tc := setupPlugin(t)
	panel := createAllTasksAdminPanel(t, tc)
	dataReq := withPathParams(adminReq(), map[string]string{"panelId": panel.ID})

	panelDataRows(t, tc.Call("POST", "/dashboard/admin-view/panels/:panelId/data", dataReq)) // populate cache

	tc.DB.SeedRows("tasks", []string{"id", "project_id", "title"}, [][]any{
		{"task-1", testProjectID, "First task"},
	})
	tc.Cache.Advance(panelDataCacheTTL + time.Minute)

	rows := panelDataRows(t, tc.Call("POST", "/dashboard/admin-view/panels/:panelId/data", dataReq))
	if len(rows) != 1 {
		t.Fatalf("expected the cache to have expired and recomputed to 1 row, got %d", len(rows))
	}
}

// TestRunPanelQuery_ForceRefreshBypassesCache exercises the frontend's
// per-panel reload button: a well-within-TTL cache hit must still be
// bypassed when the request carries ?refresh=true, and the fresh result
// must repopulate the cache for subsequent uncached calls.
func TestRunPanelQuery_ForceRefreshBypassesCache(t *testing.T) {
	tc := setupPlugin(t)
	panel := createAllTasksAdminPanel(t, tc)
	dataReq := withPathParams(adminReq(), map[string]string{"panelId": panel.ID})

	panelDataRows(t, tc.Call("POST", "/dashboard/admin-view/panels/:panelId/data", dataReq)) // populate cache

	tc.DB.SeedRows("tasks", []string{"id", "project_id", "title"}, [][]any{
		{"task-1", testProjectID, "First task"},
	})

	refreshReq := dataReq
	refreshReq.Query = map[string]string{"refresh": "true"}
	rows := panelDataRows(t, tc.Call("POST", "/dashboard/admin-view/panels/:panelId/data", refreshReq))
	if len(rows) != 1 {
		t.Fatalf("expected refresh=true to bypass the cache and recompute to 1 row, got %d", len(rows))
	}

	// The forced recompute should have repopulated the cache with the fresh
	// value, so a normal (non-refresh) call right after must see it too —
	// not fall back to whatever was cached before the refresh.
	again := panelDataRows(t, tc.Call("POST", "/dashboard/admin-view/panels/:panelId/data", dataReq))
	if len(again) != 1 {
		t.Fatalf("expected the refreshed 1-row result to now be served from cache, got %d", len(again))
	}
}

func TestUpdatePanel_InvalidatesCachedData(t *testing.T) {
	tc := setupPlugin(t)
	view := decodeData[dashboardView](t, tc.Call("GET", "/dashboard/view", callerReq()))

	panel := decodeData[dashboardPanel](t, tc.Call("POST", "/dashboard/views/:viewId/panels",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID}).
			WithJSONBody(map[string]any{
				"type":  "table",
				"title": "My tasks",
				"query": "SELECT id, title FROM tasks WHERE project_id = {{project_id}}",
			})))
	dataReq := withPathParams(callerReq(), map[string]string{"viewId": view.ID, "panelId": panel.ID})

	first := panelDataRows(t, tc.Call("POST", "/dashboard/views/:viewId/panels/:panelId/data", dataReq))
	if len(first) != 2 {
		t.Fatalf("expected 2 rows on first (uncached) run, got %d", len(first))
	}

	// Narrowing the panel's query must invalidate its cached result —
	// otherwise this would keep serving the old 2-row result for up to
	// panelDataCacheTTL after the edit. query_guard.go now requires the
	// {{project_id}} placeholder to be used as a direct "project_id =
	// {{project_id}}" equality filter and rejects comparing it against any
	// other column (see validateProjectScopePlaceholder /
	// placeholderComparisonRe) — so the previous version of this test,
	// which compared it against tasks.id to force a deterministic 0-row
	// result, is no longer a valid panel query. That's exactly the class of
	// decoy filter the guard now closes (a placeholder-equality against an
	// unrelated column doesn't actually scope the returned rows), so this
	// test needs a different way to get a deterministic, different-from-
	// before result. Querying dashboard_views instead of tasks does that
	// while still using a single valid `project_id = {{project_id}}`
	// filter: this project has exactly one dashboard_views row (the view
	// fetched at the top of this test), versus tasks' two, and
	// plugintest.InMemoryDB's minimal parser (col = $N chains only) has no
	// trouble with it.
	patchRes := tc.Call("PATCH", "/dashboard/views/:viewId/panels/:panelId",
		withPathParams(callerReq(), map[string]string{"viewId": view.ID, "panelId": panel.ID}).
			WithJSONBody(map[string]any{
				"type":  "table",
				"title": "My tasks",
				"query": "SELECT id, name FROM dashboard_views WHERE project_id = {{project_id}}",
			}))
	if patchRes.StatusCode != 200 {
		t.Fatalf("expected 200 updating the panel's query, got %d: %s", patchRes.StatusCode, patchRes.BodyString())
	}

	second := panelDataRows(t, tc.Call("POST", "/dashboard/views/:viewId/panels/:panelId/data", dataReq))
	if len(second) != 1 {
		t.Fatalf("expected the updated query's 1-row result (this project's own dashboard_views row) after cache invalidation, got %d: %+v", len(second), second)
	}
}

func TestDeletePanel_InvalidatesCachedData(t *testing.T) {
	tc := setupPlugin(t)
	panel := createAllTasksAdminPanel(t, tc)
	dataReq := withPathParams(adminReq(), map[string]string{"panelId": panel.ID})

	panelDataRows(t, tc.Call("POST", "/dashboard/admin-view/panels/:panelId/data", dataReq)) // populate cache
	if _, hit := tc.Cache.Get(panelDataCacheKey(panel.ID)); !hit {
		t.Fatal("expected panel data to be cached before delete")
	}

	res := tc.Call("DELETE", "/dashboard/admin-view/panels/:panelId", dataReq)
	if res.StatusCode != 204 {
		t.Fatalf("expected 204, got %d: %s", res.StatusCode, res.BodyString())
	}

	if _, hit := tc.Cache.Get(panelDataCacheKey(panel.ID)); hit {
		t.Fatal("expected cached panel data to be invalidated after delete")
	}
}

func TestPreviewQuery_IsNeverCached(t *testing.T) {
	tc := setupPlugin(t)

	first := panelDataRows(t, tc.Call("POST", "/dashboard/admin-query/preview",
		adminReq().WithJSONBody(map[string]any{"query": "SELECT id, project_id, title FROM tasks"})))
	if len(first) != 3 {
		t.Fatalf("expected 3 rows on first preview, got %d", len(first))
	}

	tc.DB.SeedRows("tasks", []string{"id", "project_id", "title"}, [][]any{
		{"task-1", testProjectID, "First task"},
	})

	second := panelDataRows(t, tc.Call("POST", "/dashboard/admin-query/preview",
		adminReq().WithJSONBody(map[string]any{"query": "SELECT id, project_id, title FROM tasks"})))
	if len(second) != 1 {
		t.Fatalf("expected preview to reflect the live 1-row table, got %d rows (looks cached)", len(second))
	}
}
