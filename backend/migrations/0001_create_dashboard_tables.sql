-- 0001_create_dashboard_tables.sql
-- Creates the customizable-dashboard tables in the plugin schema.
-- Run with search_path = plugin_data_com_paca_dashboard, public.
--
-- Three dashboard scopes share these two tables:
--   'project'     — exactly one row per project (the project dashboard page).
--   'admin'       — exactly one row total, project_id NULL (the admin dashboard page).
--   'integration' — any number of rows per project, user-created from the
--                   "Add view" popover on Integration pages (backlog/sprint/timeline).
--
-- Partial unique indexes enforce the "exactly one" constraint for the
-- project/admin scopes at the database level rather than relying on
-- application logic alone.

CREATE TABLE IF NOT EXISTS dashboard_views (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID        REFERENCES projects(id) ON DELETE CASCADE,
    scope      TEXT        NOT NULL CHECK (scope IN ('project', 'admin', 'integration')),
    name       TEXT        NOT NULL DEFAULT 'Dashboard',
    created_by UUID        REFERENCES project_members(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT dashboard_views_project_scope_requires_project_id
        CHECK (
            (scope = 'admin' AND project_id IS NULL) OR
            (scope IN ('project', 'integration') AND project_id IS NOT NULL)
        )
);

-- At most one 'project'-scope dashboard per project.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_views_one_project_scope
    ON dashboard_views (project_id)
    WHERE scope = 'project';

-- At most one 'admin'-scope dashboard, instance-wide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_views_one_admin_scope
    ON dashboard_views ((1))
    WHERE scope = 'admin';

CREATE INDEX IF NOT EXISTS idx_dashboard_views_project_scope
    ON dashboard_views (project_id, scope);

CREATE TABLE IF NOT EXISTS dashboard_panels (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_view_id UUID        NOT NULL REFERENCES dashboard_views(id) ON DELETE CASCADE,
    type              TEXT        NOT NULL CHECK (type IN ('chart', 'table', 'text')),
    title             TEXT        NOT NULL DEFAULT '',
    -- SQL query text for 'chart'/'table' panels; NULL for 'text' panels.
    -- See query_guard.go for the safety model enforced before execution:
    -- must be a single read-only SELECT/WITH statement, must reference the
    -- {{project_id}} placeholder (for project/integration-scoped panels),
    -- and gets a LIMIT appended if it doesn't declare one. Sensitive
    -- columns it happens to read (core platform secrets, or another
    -- plugin's own declared-sensitive fields) come back masked from the
    -- host itself, not from any table restriction here.
    query             TEXT,
    -- Chart rendering hint ('bar' | 'line' | 'donut'); NULL for table/text.
    chart_type        TEXT,
    -- Static markdown body for 'text' panels; NULL for chart/table.
    content           TEXT,
    -- Free-form visualization config (axis/series field mapping, colors,
    -- column order for table panels, etc.) — validated shape lives in the
    -- frontend; the backend treats it as an opaque JSON blob.
    viz_config        JSONB       NOT NULL DEFAULT '{}',
    pos_x             INTEGER     NOT NULL DEFAULT 0,
    pos_y             INTEGER     NOT NULL DEFAULT 0,
    width             INTEGER     NOT NULL DEFAULT 4,
    height            INTEGER     NOT NULL DEFAULT 3,
    created_by        UUID        REFERENCES project_members(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dashboard_panels_view_id
    ON dashboard_panels (dashboard_view_id);
