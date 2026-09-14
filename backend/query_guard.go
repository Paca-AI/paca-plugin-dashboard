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
//     use the literal placeholder token `{{project_id}}` exactly once, as a
//     direct `<column> = {{project_id}}` (or reversed) equality filter, with
//     no bare OR anywhere in the query; the guard then substitutes it with
//     `$1` and the caller's real project_id is bound as that parameter (see
//     validateProjectScopePlaceholder). A query with no `{{project_id}}`
//     placeholder, or one that only *contains* the token without using it as
//     a genuine per-row filter (duplicated into a self-comparison, compared
//     with anything but `=`, or otherwise made bypassable via OR), is
//     rejected outright for these scopes — this is what actually prevents
//     cross-project data leakage, since it forces every project-scoped query
//     to filter by the caller's own project in a way that can't be
//     short-circuited. Admin-scope queries are intentionally cross-project
//     and skip this requirement.
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
// word-bounded) — mutating statements, introspection, known
// sandbox-escape surfaces, and compound-SELECT operators. The latter close
// a real bypass: none of the placeholder/OR checks below understand
// multiple SELECTs contributing rows to one result, so
// "... WHERE project_id={{project_id}} UNION SELECT ... FROM tasks" (no
// filter on the second branch) satisfied every other check and returned
// every project's rows.
var forbiddenKeywords = []string{
	"insert", "update", "delete", "drop", "alter", "create", "grant",
	"revoke", "truncate", "copy", "call", "execute", "explain", "vacuum",
	"analyze", "reindex", "lock", "listen", "notify", "do",
	"pg_sleep", "pg_read_file", "pg_read_binary_file", "pg_ls_dir",
	"dblink", "lo_import", "lo_export", "information_schema", "pg_catalog",
	"pg_shadow", "pg_authid", "current_setting", "set_config",
	"union", "intersect", "except",
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

// placeholderComparisonRe matches "project_id = {{project_id}}" or
// "{{project_id}} = project_id" (optionally table/alias-qualified, e.g.
// "t.project_id"), run against the *redacted* query text (see
// redactForStructuralChecks) rather than the raw query. Two things narrow
// this beyond a bare "some column somewhere":
//
//   - The column name must literally be project_id, not any identifier.
//     Every real use in this file's own docs/tests filters on project_id;
//     requiring the name closes a decoy like
//     "FROM tasks, projects WHERE projects.id = {{project_id}}" — a
//     cross join whose only placeholder use filters an unrelated table's
//     primary key, leaving the actually-returned tasks rows unfiltered.
//   - Running against the redacted text means a match can't be hiding
//     inside a string literal or a nested subquery — see
//     redactForStructuralChecks's doc comment for why the latter matters.
var placeholderComparisonRe = regexp.MustCompile(
	`(?i)(?:[A-Za-z_][A-Za-z0-9_]*\.)?project_id\s*=\s*` + regexp.QuoteMeta(placeholderToken) +
		`|` + regexp.QuoteMeta(placeholderToken) + `\s*=\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)?project_id`,
)

// validateProjectScopePlaceholder enforces that {{project_id}} appears
// exactly once and is used as a direct, unconditional equality filter
// against a real column — closing two concrete bypasses that a bare
// "contains the placeholder somewhere" check allows through:
//
//   - A duplicated/self-compared placeholder, e.g.
//     "WHERE '{{project_id}}' = '{{project_id}}'", which becomes an
//     always-true tautology once both sides are substituted with the same
//     bound value — the old check only verified the token appeared
//     *somewhere*, so this passed.
//   - The placeholder appearing correctly, but alongside a bare OR that can
//     make the whole filter match regardless of project, e.g.
//     "WHERE 1=1 OR project_id = {{project_id}}". Reasoning about which
//     OR/parenthesis nestings are "safe" would require a real SQL parser
//     (a parenthesized OR can still be just as unsafe as a bare one, e.g.
//     "WHERE (other_col = 5 OR project_id = {{project_id}})" — the parens
//     don't stop it from being the entire filter), so OR is rejected
//     outright for project/integration-scoped queries rather than
//     attempting to classify individual uses as safe. Use IN (...) for a
//     multi-value filter instead.
func validateProjectScopePlaceholder(query string) error {
	count := strings.Count(query, placeholderToken)
	if count == 0 {
		return invalidQuery(
			"query must scope itself to the current project using the %s placeholder somewhere in a WHERE/ON/HAVING clause (e.g. \"WHERE project_id = %s\")",
			placeholderToken, placeholderToken,
		)
	}
	if count > 1 {
		return invalidQuery("the %s placeholder must appear exactly once", placeholderToken)
	}

	redacted := redactForStructuralChecks(query)

	if hasBareOr(redacted) {
		return invalidQuery("OR is not allowed in panel queries, since it could bypass the project filter — use IN (...) for a multi-value filter instead")
	}
	if !placeholderComparisonRe.MatchString(redacted) {
		return invalidQuery(
			"the %s placeholder must be used as a direct equality filter against a project_id column, at the query's own top level (not inside a nested subquery), e.g. \"WHERE project_id = %s\" — it cannot be compared with anything other than \"=\", against a different column, duplicated, or embedded inside a string literal or larger expression",
			placeholderToken, placeholderToken,
		)
	}
	return nil
}

// redactForStructuralChecks returns a same-length copy of query with the
// content of every single-quoted string literal, double-quoted identifier,
// and nested SELECT/WITH subquery (anything inside parentheses that open
// with SELECT or WITH, at any depth) blanked out to spaces. hasBareOr and
// placeholderComparisonRe both run against this redacted form instead of
// the raw query, for two independent reasons:
//
//   - String-literal content can contain a stray quote, paren, or
//     keyword-looking text that isn't SQL syntax at all.
//   - A nested subquery can contain a placeholder-equality that satisfies
//     placeholderComparisonRe by pure text matching without actually
//     constraining which rows the *outer* query returns — e.g.
//     "SELECT id,title FROM tasks WHERE (SELECT 1 FROM projects WHERE
//     id={{project_id}}) IS NOT NULL" filters on an unrelated existence
//     check while every row of tasks (every project's) comes back
//     unfiltered. Blanking nested-subquery spans means a placeholder
//     hiding in one no longer counts as a valid top-level filter, so this
//     query now correctly falls through to "no placeholder used as a
//     direct equality filter" and is rejected. Legitimate queries are
//     expected to place the filter in their own top-level WHERE (every
//     example in this file's docs/tests already does), so this doesn't
//     restrict the documented usage pattern.
func redactForStructuralChecks(query string) string {
	runes := []rune(query)
	out := make([]rune, len(runes))
	copy(out, runes)

	inSingle, inDouble := false, false
	var subqueryParen []bool // one entry per currently-open paren; true if it opens a nested SELECT/WITH

	insideSubquery := func() bool {
		for _, sq := range subqueryParen {
			if sq {
				return true
			}
		}
		return false
	}

	for i := 0; i < len(runes); i++ {
		c := runes[i]

		if inSingle {
			if c == '\'' {
				if i+1 < len(runes) && runes[i+1] == '\'' {
					out[i], out[i+1] = ' ', ' '
					i++
					continue
				}
				inSingle = false
				continue
			}
			out[i] = ' '
			continue
		}
		if inDouble {
			if c == '"' {
				if i+1 < len(runes) && runes[i+1] == '"' {
					out[i], out[i+1] = ' ', ' '
					i++
					continue
				}
				inDouble = false
				continue
			}
			out[i] = ' '
			continue
		}

		switch c {
		case '\'':
			inSingle = true
			continue
		case '"':
			inDouble = true
			continue
		case '(':
			subqueryParen = append(subqueryParen, startsWithSelectOrWith(runes[i+1:]))
			continue
		case ')':
			if len(subqueryParen) > 0 {
				subqueryParen = subqueryParen[:len(subqueryParen)-1]
			}
			continue
		}

		if insideSubquery() {
			out[i] = ' '
		}
	}
	return string(out)
}

// startsWithSelectOrWith reports whether after, everything immediately
// following an opening paren, begins (modulo leading whitespace) with the
// keyword SELECT or WITH — i.e. whether that paren opens a nested
// subquery/CTE rather than a plain grouping expression like
// "(project_id = {{project_id}})" or "(a = 1 AND b = 2)".
func startsWithSelectOrWith(after []rune) bool {
	i := 0
	for i < len(after) && (after[i] == ' ' || after[i] == '\t' || after[i] == '\n' || after[i] == '\r') {
		i++
	}
	return isWordBoundaryKeyword(after, i, "select") || isWordBoundaryKeyword(after, i, "with")
}

// hasBareOr reports whether query contains the keyword OR outside of a
// string literal (single- or double-quoted — see redactForStructuralChecks,
// which callers are expected to have already applied) and not as part of a
// longer identifier (e.g. "corporation", "order").
func hasBareOr(query string) bool {
	runes := []rune(query)
	for i := 0; i < len(runes); i++ {
		if isWordBoundaryKeyword(runes, i, "or") {
			return true
		}
	}
	return false
}

// isWordBoundaryKeyword reports whether the case-insensitive keyword kw
// occurs at position i in runes, bounded by non-identifier characters (or
// the string's edges) on both sides.
func isWordBoundaryKeyword(runes []rune, i int, kw string) bool {
	n := len(kw)
	if i+n > len(runes) {
		return false
	}
	if !strings.EqualFold(string(runes[i:i+n]), kw) {
		return false
	}
	if i > 0 && isIdentRune(runes[i-1]) {
		return false
	}
	if i+n < len(runes) && isIdentRune(runes[i+n]) {
		return false
	}
	return true
}

func isIdentRune(r rune) bool {
	return r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
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
		if err := validateProjectScopePlaceholder(trimmed); err != nil {
			return "", err
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
