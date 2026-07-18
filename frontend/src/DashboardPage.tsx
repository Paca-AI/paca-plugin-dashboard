/**
 * DashboardPage — the shared view behind both the `project.page` and
 * `admin.page` entry components exposed by the dashboard plugin (see the
 * thin wrappers in ProjectDashboardPage.tsx and AdminDashboardPage.tsx).
 * One component covers both scopes because they differ only in data
 * source and shape — project scope shows one project's status breakdown,
 * active sprint, and member workload; admin scope shows a cross-project
 * task-count table — while the page shell, stat-card row, and loading/
 * error states are otherwise identical in spirit to the time-logging
 * plugin's TimeTrackingPage split.
 */

import { PluginApiClient, PluginQueryClientProvider } from "@paca-ai/plugin-sdk-react";
import { LayoutDashboard } from "lucide-react";
import { useMemo } from "react";
import {
  CATEGORY_FALLBACK_COLOR,
  useInstanceOverview,
  useProjectOverview,
} from "./shared";
import { StatCard } from "./widgets";
import ProjectOverviewSection from "./ProjectOverviewSection";
import InstanceOverviewSection from "./InstanceOverviewSection";

// ── Scope ─────────────────────────────────────────────────────────────────────

export type DashboardScope =
  | { kind: "project"; projectId: string }
  | { kind: "admin" };

interface DashboardPageProps {
  scope: DashboardScope;
}

export default function DashboardPage({ scope }: DashboardPageProps) {
  return (
    <PluginQueryClientProvider>
      <DashboardPageInner scope={scope} />
    </PluginQueryClientProvider>
  );
}

function DashboardPageInner({ scope }: DashboardPageProps) {
  const isProject = scope.kind === "project";
  const projectId = scope.kind === "project" ? scope.projectId : undefined;

  const api = useMemo(
    () =>
      new PluginApiClient({
        baseUrl: `${window.location.origin}/api/v1`,
        projectId: projectId ?? "",
        fetch: (url, init) =>
          window.fetch(url, { ...init, credentials: "include" }),
      }),
    [projectId],
  );

  const title = isProject ? "Dashboard" : "Dashboard — All Projects";
  const description = isProject
    ? "At-a-glance status breakdown, active sprint progress, and team workload for this project."
    : "Cross-project task overview across every project on this instance.";

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl w-full mx-auto">
      <div>
        <div className="flex items-center gap-2">
          <LayoutDashboard className="size-5 text-primary" />
          <h1 className="text-xl font-semibold">{title}</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>

      {isProject ? (
        <ProjectOverviewSection api={api} projectId={projectId as string} />
      ) : (
        <InstanceOverviewSection api={api} />
      )}
    </div>
  );
}

export { StatCard, CATEGORY_FALLBACK_COLOR, useProjectOverview, useInstanceOverview };
