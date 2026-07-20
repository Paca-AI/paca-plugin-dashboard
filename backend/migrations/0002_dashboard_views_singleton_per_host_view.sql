-- 0002_dashboard_views_singleton_per_host_view.sql
-- Integration-scope dashboards ("Dashboard" views inside Integration pages)
-- used to be an unlimited, user-managed list per project, with their own
-- tab strip (list/create/rename/delete) inside DashboardIntegrationView.tsx.
--
-- That's being replaced with the same "exactly one dashboard" model already
-- used by the project/admin scopes: each host-side interaction view (a
-- Timeline/Backlog/Sprint page's "Dashboard" view, created via the host's
-- own "Add view" popover) now gets exactly one dashboard, identified by the
-- host's own view row id (host_view_id) rather than a plugin-managed list.
--
-- host_view_id is only ever set for scope='integration' — project/admin
-- scope dashboards have no corresponding host view row (they're reached via
-- a nav item, not a view-picker entry) and stay NULL here, same as
-- project_id already does for the admin scope.

ALTER TABLE dashboard_views
    ADD COLUMN IF NOT EXISTS host_view_id UUID;

-- At most one integration-scope dashboard per host view (get-or-create
-- singleton, mirrors uq_dashboard_views_one_project_scope /
-- uq_dashboard_views_one_admin_scope for the other two scopes).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_views_one_per_host_view
    ON dashboard_views (host_view_id)
    WHERE scope = 'integration';
