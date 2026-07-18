/**
 * shared.tsx — data-fetching hooks shared by the project-scope and
 * admin-scope dashboard pages. Kept separate from DashboardPage.tsx so the
 * fetch layer (query keys, endpoint paths) is easy to find independent of
 * rendering, matching the split used by the time-logging plugin's
 * shared.tsx / TimeTrackingPage.tsx.
 */

import type { PluginApiClient } from "@paca-ai/plugin-sdk-react";
import { useQuery } from "@tanstack/react-query";
import { PLUGIN_ID } from "./constants";
import type { InstanceOverview, ProjectOverview } from "./types";

/** Fetches the project-scoped overview (status breakdown, active sprint, workload). */
export function useProjectOverview(
  api: PluginApiClient,
  projectId: string,
): { data: ProjectOverview | undefined; isLoading: boolean; error: Error | null } {
  const { data, isLoading, error } = useQuery<ProjectOverview, Error>({
    queryKey: ["plugin", PLUGIN_ID, "overview", projectId],
    queryFn: () =>
      api.pluginGet<ProjectOverview>(
        PLUGIN_ID,
        `/projects/${projectId}/dashboard/overview`,
      ),
    staleTime: 30 * 1000,
  });
  return { data, isLoading, error: error ?? null };
}

/** Fetches the cross-project admin-scope overview. */
export function useInstanceOverview(
  api: PluginApiClient,
): { data: InstanceOverview | undefined; isLoading: boolean; error: Error | null } {
  const { data, isLoading, error } = useQuery<InstanceOverview, Error>({
    queryKey: ["plugin", PLUGIN_ID, "overview-all"],
    queryFn: () => api.pluginGet<InstanceOverview>(PLUGIN_ID, "/dashboard/overview-all"),
    staleTime: 30 * 1000,
  });
  return { data, isLoading, error: error ?? null };
}

/** Status-category colors used when a status row doesn't carry its own color. */
export const CATEGORY_FALLBACK_COLOR: Record<string, string> = {
  backlog: "#94a3b8",
  refinement: "#a78bfa",
  ready: "#38bdf8",
  todo: "#94a3b8",
  inprogress: "#3b82f6",
  done: "#22c55e",
};
