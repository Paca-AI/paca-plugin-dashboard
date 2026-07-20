/**
 * ProjectDashboardPage.tsx — the `project.page` entry component exposed by
 * the dashboard plugin, reached via a dedicated project sidebar nav item.
 * Fetches (get-or-creates) the project's singleton dashboard view and
 * renders it through the shared DashboardBody (grid + panel editor),
 * identical machinery to AdminDashboardPage and DashboardIntegrationView.
 */

import { useMemo } from "react";
import { PluginApiClient, PluginQueryClientProvider } from "@paca-ai/plugin-sdk-react";
import type { ProjectPageProps } from "@paca-ai/plugin-sdk-react";
import { LayoutDashboard } from "lucide-react";
import { useProjectDashboardView } from "./api";
import { DashboardBody } from "./DashboardBody";

export default function ProjectDashboardPage(props: ProjectPageProps) {
  return (
    <PluginQueryClientProvider>
      <Content {...props} />
    </PluginQueryClientProvider>
  );
}

function Content({ api }: ProjectPageProps) {
  const viewQuery = useProjectDashboardView(api);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl w-full mx-auto">
      <div>
        <div className="flex items-center gap-2">
          <LayoutDashboard className="size-5 text-primary" />
          <h1 className="text-xl font-semibold">Dashboard</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Build a custom panel-based dashboard for this project — add chart, table, or text panels
          and arrange them however you like.
        </p>
      </div>

      {viewQuery.isLoading && <p className="text-sm text-muted-foreground">Loading dashboard…</p>}
      {viewQuery.isError && <p className="text-sm text-destructive">Failed to load this project's dashboard.</p>}
      {viewQuery.data && <DashboardBody api={api} scope="project" view={viewQuery.data} canEdit />}
    </div>
  );
}
