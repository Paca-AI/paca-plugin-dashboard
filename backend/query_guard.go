// query_guard.go — safety layer for user-authored panel queries.
//
// Chosen safety model (raw SQL, backend-enforced guardrails — the middle
// ground between a fully structured query builder and unrestricted raw
// SQL): the host's Postgres is a single shared, multi-tenant database, so
// an unrestricted SQL textbox (real Grafana's model) would let one
// project's dashboard author read another project's task titles or
// documents. Rather than ban raw SQL outright (which caps flexibility to
// whatever a structured builder can express), every submitted query is
// validated by validateQuery below before it ever reaches p.db.Query:
//
//  1. Exactly one statement, and it must be a SELECT/WITH (no INSERT,
//     UPDATE, DELETE, DROP, ALTER, CREATE, GRANT, TRUNCATE, COPY, CALL,
//     EXPLAIN, VACUUM, or a trailing second statement after a semicolon).
//  2. No use of information_schema/pg_catalog/pg_* introspection
//     functions, dblink, lo_*, or COPY — closes the standard sandbox-escape
//     tricks for a restricted SQL surface.
//  3. Project-scoped queries (project + integration dashboard scopes) must
//     contain the literal placeholder token `{{project_id}}` somewhere in
//     a WHERE/ON/HAVING clause; the guard substitutes it with `$1` and the
//     caller's real project_id is bound as that parameter. A query with no
//     `{{project_id}}` placeholder is rejected outright for these scopes —
//     this is what actually prevents cross-project data leakage, since it
//     forces every project-scoped query to filter by the caller's own
//     project. Admin-scope queries are intentionally cross-project and skip
//     this requirement.
//  4. An explicit LIMIT is appended (LIMIT 500) when the query doesn't
//     already declare one, bounding worst-case result size / query cost.
//
// This guard used to also enforce a per-table read whitelist (excluding
// users.password_hash, api_keys, agents.llm_api_key_secret, and every
// other plugin's schema). That's gone: which columns are sensitive is now
// the host's job, not this plugin's guess — the API's db_query/db_query2
// (services/api/internal/platform/plugin/runtime.go) redacts any column a
// plugin.json declares sensitive (via backend.sensitiveFields, or the
// host's own core registry for platform secrets) to "***" for every
// caller except the declared owner/requester. A panel query against
// `users` or another plugin's schema now reaches Postgres — it just gets
// masked sensitive values back, the same as any other plugin would.
//
// This is a pattern-based guard, not a full SQL parser — it cannot catch
// every conceivable obfuscation (e.g. table names hidden behind dynamic
// SQL, which Postgres doesn't support in a plain SELECT anyway). It is
// deliberately conservative: anything the guard can't confidently classify
// as safe is rejected rather than allowed through.
package main

import (
	"fmt"
	"regexp"
	"strings"
)

// forbiddenKeywords are rejected anywhere in the query (case-insensitive,
// word-bounded) — mutating statements, introspection, and known
// sandbox-escape surfaces.
var forbiddenKeywords = []string{
	"insert", "update", "delete", "drop", "alter", "create", "grant",
	"revoke", "truncate", "copy", "call", "execute", "explain", "vacuum",
	"analyze", "reindex", "lock", "listen", "notify", "do",
	"pg_sleep", "pg_read_file", "pg_read_binary_file", "pg_ls_dir",
	"dblink", "lo_import", "lo_export", "information_schema", "pg_catalog",
	"pg_shadow", "pg_authid", "current_setting", "set_config",
}

var identWordRe = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_]*`)
var fromJoinTableRe = regexp.MustCompile(`(?i)\b(?:from|join)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?`)
var limitRe = regexp.MustCompile(`(?i)\blimit\s+\d+`)
var placeholderToken = "{{project_id}}"

// queryValidationError is returned to the caller verbatim (400 response),
// so messages are written to be actionable for whoever is authoring the
// panel query.
type queryValidationError struct {
	msg string
}

func (e *queryValidationError) Error() string { return e.msg }

func invalidQuery(format string, args ...any) error {
	return &queryValidationError{msg: fmt.Sprintf(format, args...)}
}

// validateQuery checks a raw panel query string against the safety model
// described above. requireProjectScope is true for 'project' and
// 'integration' scope panels (false for 'admin' scope, which is
// intentionally cross-project). Returns the rewritten, execution-ready SQL
// (placeholder substituted, LIMIT appended if missing) or an error
// explaining exactly what's disallowed.
func validateQuery(raw string, requireProjectScope bool) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", invalidQuery("query must not be empty")
	}

	// Reject multiple statements: at most one trailing semicolon is
	// allowed, and nothing may follow it but whitespace.
	if idx := strings.Index(trimmed, ";"); idx != -1 {
		rest := strings.TrimSpace(trimmed[idx+1:])
		if rest != "" {
			return "", invalidQuery("only a single SELECT statement is allowed (found content after ';')")
		}
		trimmed = strings.TrimSpace(trimmed[:idx])
	}

	lower := strings.ToLower(trimmed)
	if !strings.HasPrefix(lower, "select") && !strings.HasPrefix(lower, "with") {
		return "", invalidQuery("query must start with SELECT (or WITH ... SELECT)")
	}

	for _, word := range identWordRe.FindAllString(lower, -1) {
		for _, bad := range forbiddenKeywords {
			if word == bad {
				return "", invalidQuery("keyword %q is not allowed in panel queries", bad)
			}
		}
	}

	if !fromJoinTableRe.MatchString(trimmed) {
		return "", invalidQuery("query must reference at least one FROM/JOIN table")
	}

	if requireProjectScope {
		if !strings.Contains(trimmed, placeholderToken) {
			return "", invalidQuery(
				"query must scope itself to the current project using the %s placeholder somewhere in a WHERE/ON/HAVING clause (e.g. \"WHERE project_id = %s\")",
				placeholderToken, placeholderToken,
			)
		}
		// $1 is reserved for the injected project_id; reject any other
		// use of $1 so we don't silently override a user's own parameter.
		if strings.Contains(trimmed, "$1") {
			return "", invalidQuery("do not use $1 directly — it is reserved for the injected project_id; use the %s placeholder instead", placeholderToken)
		}
		trimmed = strings.ReplaceAll(trimmed, placeholderToken, "$1")
	} else if strings.Contains(trimmed, placeholderToken) {
		return "", invalidQuery("the %s placeholder is only valid for project/integration-scoped panels, not admin-scope panels", placeholderToken)
	}

	if !limitRe.MatchString(trimmed) {
		trimmed = trimmed + " LIMIT 500"
	}

	return trimmed, nil
}
