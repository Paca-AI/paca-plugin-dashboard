package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	plugin "github.com/Paca-AI/plugin-sdk-go"
	"github.com/Paca-AI/plugin-sdk-go/plugintest"
)

// ── Helpers ───────────────────────────────────────────────────────────────────

const testProjectID = "project-1"

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

// ── Pure-logic unit tests ────────────────────────────────────────────────────

func TestRound1(t *testing.T) {
	cases := []struct {
		in   float64
		want float64
	}{
		{0, 0},
		{33.33333, 33.3},
		{66.66666, 66.7},
		{100, 100},
		{12.05, 12.1}, // half-up rounding
	}
	for _, c := range cases {
		if got := round1(c.in); got != c.want {
			t.Errorf("round1(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestScanner_StrAndIntVal(t *testing.T) {
	cols := []string{"id", "count", "name"}
	row := []any{"abc", float64(7), nil}
	sc := newRowScanner(cols, row)

	if got := sc.str("id"); got != "abc" {
		t.Errorf("str(id) = %q, want %q", got, "abc")
	}
	if got := sc.intVal("count"); got != 7 {
		t.Errorf("intVal(count) = %d, want 7", got)
	}
	if got := sc.str("name"); got != "" {
		t.Errorf("str(name) = %q, want empty for nil value", got)
	}
	if got := sc.intVal("missing_col"); got != 0 {
		t.Errorf("intVal(missing_col) = %d, want 0", got)
	}
}

// ── Route handler smoke tests ────────────────────────────────────────────────
//
// projectOverview and instanceOverview aggregate across task_statuses,
// tasks, sprints, task_assignees, project_members, and users via SQL JOINs,
// GROUP BY, and FILTER (WHERE ...) clauses — real PostgreSQL features the
// plugin relies on in production. plugintest's InMemoryDB intentionally only
// supports single-table "SELECT ... FROM t [WHERE col = $N]" queries (see
// its doc comment), the same limitation that already left the time-logging
// plugin's analogous multi-join admin-scope aggregates (listAllTimeLogs,
// timeLogsSummaryAll) untested via plugintest — see that file's comment
// above TestUpdateTimeLogGlobal_Success. Full aggregation correctness for
// this plugin should be verified with a real Postgres instance in an
// integration/e2e suite; here we only confirm the handlers are wired up and
// surface DB errors instead of panicking, matching the coverage level the
// existing plugins apply to this same class of query.

func TestProjectOverview_WiredUp(t *testing.T) {
	tc := plugintest.NewContext(t)
	var p dashboardPlugin
	if err := p.Init(tc.PluginContext()); err != nil {
		t.Fatal("Init failed:", err)
	}

	res := tc.Call("GET", "/dashboard/overview", callerReq())
	// No tables seeded (InMemoryDB can't run this plugin's JOIN/GROUP BY
	// queries anyway) — assert the handler is reachable and fails cleanly
	// with a 500 + logged error rather than panicking, instead of asserting
	// on aggregation results it cannot actually compute here.
	if res.StatusCode != 500 {
		t.Fatalf("expected 500 (InMemoryDB can't execute JOIN/GROUP BY), got %d: %s", res.StatusCode, res.BodyString())
	}
	if !tc.Log.HasMessage("projectOverview") {
		t.Fatalf("expected an error to be logged mentioning projectOverview, got: %+v", tc.Log.Entries())
	}
}

func TestInstanceOverview_WiredUp(t *testing.T) {
	tc := plugintest.NewContext(t)
	var p dashboardPlugin
	if err := p.Init(tc.PluginContext()); err != nil {
		t.Fatal("Init failed:", err)
	}

	res := tc.Call("GET", "/dashboard/overview-all", plugintest.Request{})
	// Unlike projectOverview's queries (which hit a WHERE clause the fake
	// parser can't evaluate against an unseeded table and so error),
	// instanceOverview's query has no WHERE clause at all; InMemoryDB
	// resolves an unseeded "projects" table to a valid empty result set
	// instead of an error (see InMemoryDB.querySelect). Assert the handler
	// is reachable and returns a well-formed empty overview.
	if res.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", res.StatusCode, res.BodyString())
	}
	var env struct {
		Data instanceOverviewData `json:"data"`
	}
	if err := json.Unmarshal(res.Body, &env); err != nil {
		t.Fatal(err)
	}
	if env.Data.ProjectCount != 0 || len(env.Data.Projects) != 0 {
		t.Fatalf("expected an empty overview, got %+v", env.Data)
	}
}

// ── Manifest / route registration parity ─────────────────────────────────────
//
// Mirrors the same guard used by the time-logging and checklist plugins:
// every route declared in plugin.json must resolve to a handler actually
// registered via ctx.Route in Init(), so a manifest/backend drift doesn't
// silently fall back to the host's default (no permission check) policy.

func TestManifestRoutesMatchRegisteredRoutes(t *testing.T) {
	data, err := os.ReadFile("../plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Backend struct {
			Routes []struct {
				Method string `json:"method"`
				Path   string `json:"path"`
			} `json:"routes"`
		} `json:"backend"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Backend.Routes) == 0 {
		t.Fatal("plugin.json declares no backend routes")
	}

	tc := plugintest.NewContext(t)
	var p dashboardPlugin
	if err := p.Init(tc.PluginContext()); err != nil {
		t.Fatal(err)
	}
	for _, r := range m.Backend.Routes {
		relPath := stripProjectPrefix(r.Path)
		req := &plugin.Request{PathParams: map[string]string{}}
		res := plugin.NewResponse()
		if ok := plugin.DispatchRoute(tc.PluginContext(), r.Method, relPath, req, res); !ok {
			t.Errorf("plugin.json declares %s %s (relative path %s) but Init() registers no matching route",
				r.Method, r.Path, relPath)
		}
	}
}

// stripProjectPrefix mirrors plugin-sdk-go's splitProjectPath: it strips a
// leading "/projects/<segment>" pair so a manifest path can be compared
// against the relative pattern registered via ctx.Route in Init().
func stripProjectPrefix(path string) string {
	const prefix = "/projects/"
	if !strings.HasPrefix(path, prefix) {
		return path
	}
	rest := strings.TrimPrefix(path, prefix)
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) < 2 {
		return "/"
	}
	return "/" + parts[1]
}
