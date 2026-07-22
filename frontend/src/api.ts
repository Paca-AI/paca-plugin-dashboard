/**
 * api.ts — data-fetching hooks and mutations for the panel-based dashboard
 * builder, shared across the project/admin pages and the Integration-page
 * dashboard views. Kept separate from the page/component files so the
 * fetch layer (query keys, endpoint paths) is easy to find independently
 * of rendering — same split used by the time-logging plugin.
 *
 * Endpoint map (see backend/plugin.go for the full route table):
 *   GET    /dashboard/view                              — project singleton
 *   GET    /dashboard/admin-view                         — admin singleton
 *   GET    /dashboard/view/:hostViewId                   — integration singleton (one per host view)
 *   GET    /dashboard/views/:viewId                      — any scope, by resolved dashboard id
 *   POST   /dashboard/views/:viewId/panels                (or /admin-view/panels)
 *   PATCH  /dashboard/views/:viewId/panels/:panelId
 *   DELETE /dashboard/views/:viewId/panels/:panelId
 *   PATCH  /dashboard/views/:viewId/panels/layout
 *   POST   /dashboard/views/:viewId/panels/:panelId/data
 *   POST   /dashboard/query/preview (or /dashboard/admin-query/preview)
 */

import type { PluginApiClient } from "@paca-ai/plugin-sdk-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { PLUGIN_ID } from "./constants";
import type {
  DashboardScopeKind,
  DashboardView,
  PanelInput,
  PanelLayoutEntry,
  QueryResult,
} from "./types";

/** Resolves the view-scoped base path for panel/layout/data routes. Project
 * and integration scopes must go through the host's `/projects/:projectId`
 * prefix — PluginApiClient does not inject it automatically, see
 * api-client.ts's pluginGet doc comment. Admin scope has no project. */
function viewBasePath(api: PluginApiClient, scope: DashboardScopeKind, viewId: string): string {
  return scope === "admin"
    ? "/dashboard/admin-view"
    : `/projects/${api.projectId}/dashboard/views/${viewId}`;
}

function previewPath(api: PluginApiClient, scope: DashboardScopeKind): string {
  return scope === "admin"
    ? "/dashboard/admin-query/preview"
    : `/projects/${api.projectId}/dashboard/query/preview`;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function useProjectDashboardView(api: PluginApiClient) {
  return useQuery<DashboardView, Error>({
    queryKey: ["plugin", PLUGIN_ID, "view", "project"],
    queryFn: () => api.pluginGet<DashboardView>(PLUGIN_ID, `/projects/${api.projectId}/dashboard/view`),
    staleTime: 10 * 1000,
  });
}

export function useAdminDashboardView(api: PluginApiClient) {
  return useQuery<DashboardView, Error>({
    queryKey: ["plugin", PLUGIN_ID, "view", "admin"],
    queryFn: () => api.pluginGet<DashboardView>(PLUGIN_ID, "/dashboard/admin-view"),
    staleTime: 10 * 1000,
  });
}

/** Get-or-creates the single dashboard belonging to one host interaction
 * view (a "Dashboard"-type view in Backlog/Sprint/Timeline) — hostViewId is
 * the host's own view record id (ViewExtensionProps.viewId), not a
 * plugin-managed id. Exactly one dashboard per host view. */
export function useIntegrationDashboardView(api: PluginApiClient, hostViewId: string) {
  return useQuery<DashboardView, Error>({
    queryKey: ["plugin", PLUGIN_ID, "view", "integration", hostViewId],
    queryFn: () =>
      api.pluginGet<DashboardView>(PLUGIN_ID, `/projects/${api.projectId}/dashboard/view/${hostViewId}`),
    enabled: !!hostViewId,
    staleTime: 10 * 1000,
  });
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/** Invalidates every cached view/list query — simplest-correct approach given
 * the small query surface here (no need for granular per-view invalidation). */
function useInvalidateDashboards(api: PluginApiClient) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["plugin", PLUGIN_ID] });
}

export function useCreatePanel(api: PluginApiClient, scope: DashboardScopeKind, viewId: string) {
  const invalidate = useInvalidateDashboards(api);
  const base = viewBasePath(api, scope, viewId);
  return useMutation({
    mutationFn: (panel: PanelInput) => api.pluginPost(PLUGIN_ID, `${base}/panels`, panel),
    onSuccess: invalidate,
  });
}

export function useUpdatePanel(api: PluginApiClient, scope: DashboardScopeKind, viewId: string) {
  const invalidate = useInvalidateDashboards(api);
  const base = viewBasePath(api, scope, viewId);
  return useMutation({
    mutationFn: ({ panelId, panel }: { panelId: string; panel: PanelInput }) =>
      api.pluginPatch(PLUGIN_ID, `${base}/panels/${panelId}`, panel),
    onSuccess: invalidate,
  });
}

export function useDeletePanel(api: PluginApiClient, scope: DashboardScopeKind, viewId: string) {
  const invalidate = useInvalidateDashboards(api);
  const base = viewBasePath(api, scope, viewId);
  return useMutation({
    mutationFn: (panelId: string) => api.pluginDelete(PLUGIN_ID, `${base}/panels/${panelId}`),
    onSuccess: invalidate,
  });
}

export function useUpdatePanelLayout(api: PluginApiClient, scope: DashboardScopeKind, viewId: string) {
  const invalidate = useInvalidateDashboards(api);
  const base = viewBasePath(api, scope, viewId);
  return useMutation({
    mutationFn: (panels: PanelLayoutEntry[]) =>
      api.pluginPatch(PLUGIN_ID, `${base}/panels/layout`, { panels }),
    // Layout drags happen often; skip the full invalidate to avoid grid
    // flicker mid-drag session — caller already holds optimistic local state.
    onSuccess: () => {},
  });
}

/** Plain fetcher, not a `useMutation` — callers (DashboardBody) fire this
 * once per panel concurrently on mount, and a single shared mutation
 * observer can only track one in-flight call's callbacks at a time. Firing
 * `.mutate()` for panel B before panel A settles detaches A's observer, so
 * A's onSuccess/onSettled never runs even though its request succeeds
 * (panel stuck on "Loading…"). A plain function per call has no shared
 * state to race on.
 *
 * `forceRefresh` bypasses the backend's panel-data cache (5-minute TTL) —
 * pass it for an explicit user action (the panel's reload button) so
 * clicking reload can't just hand back the same stale cached result;
 * mount-time auto-fetches omit it and are fine reading from cache. */
export function usePanelDataFetcher(api: PluginApiClient, scope: DashboardScopeKind, viewId: string) {
  const base = viewBasePath(api, scope, viewId);
  return useCallback(
    (panelId: string, forceRefresh = false) =>
      api.pluginPost<QueryResult>(
        PLUGIN_ID,
        `${base}/panels/${panelId}/data${forceRefresh ? "?refresh=true" : ""}`,
        {},
      ),
    [api, base],
  );
}

export function useQueryPreview(api: PluginApiClient, scope: DashboardScopeKind) {
  return useMutation({
    mutationFn: (query: string) =>
      api.pluginPost<QueryResult>(PLUGIN_ID, previewPath(api, scope), { query }),
  });
}
