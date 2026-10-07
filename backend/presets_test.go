package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Every SQL preset shipped to users (the frontend's "insert a preset" list) and
// to agents (the paca-dashboard-builder skill) must pass the same guard a saved
// panel goes through, or it fails the moment someone uses it.

var (
	presetBlock     = regexp.MustCompile("(?s)\\{\\s*id: \"([^\"]+)\".*?scopes: \\[([^\\]]*)\\].*?query: `(.*?)`")
	presetConst     = regexp.MustCompile("(?s)const ([A-Z_]+) = `(.*?)`;")
	skillSQLBlock   = regexp.MustCompile("(?s)```sql\\n(.*?)```")
	placeholderUsed = "{{project_id}}"
)

func TestFrontendPresetsPassTheQueryGuard(t *testing.T) {
	src, err := os.ReadFile("../frontend/src/presets.ts")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	for _, m := range presetConst.FindAllStringSubmatch(text, -1) {
		text = strings.ReplaceAll(text, "${"+m[1]+"}", m[2])
	}
	presets := presetBlock.FindAllStringSubmatch(text, -1)
	if len(presets) == 0 {
		t.Fatal("found no presets in presets.ts; the parser is out of date")
	}
	for _, m := range presets {
		id, scopes, query := m[1], m[2], m[3]
		projectScoped := strings.Contains(scopes, "project") || strings.Contains(scopes, "integration")
		if _, err := validateQuery(query, projectScoped); err != nil {
			t.Errorf("preset %q is rejected by the query guard: %v", id, err)
		}
	}
}

func TestSkillPresetsPassTheQueryGuard(t *testing.T) {
	src, err := os.ReadFile("../skills/paca-dashboard-builder/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	blocks := skillSQLBlock.FindAllStringSubmatch(string(src), -1)
	if len(blocks) == 0 {
		t.Fatal("found no ```sql blocks in SKILL.md; the parser is out of date")
	}
	for _, m := range blocks {
		query := strings.TrimSpace(m[1])
		// Admin presets are the ones written without the placeholder; the guard
		// rejects the placeholder in admin scope and requires it in project scope.
		projectScoped := strings.Contains(query, placeholderUsed)
		if _, err := validateQuery(query, projectScoped); err != nil {
			first := strings.SplitN(query, "\n", 2)[0]
			t.Errorf("skill preset starting %q is rejected by the query guard: %v", first, err)
		}
	}
}
