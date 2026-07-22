/**
 * AdminDashboardPage.tsx — the `admin.page` entry component exposed by the
 * dashboard plugin, reached via a dedicated nav item in the admin sidebar;
 * gated by the built-in `users.write` global permission (see plugin.json),
 * matching the host's other admin pages. Fetches (get-or-creates) the
 * instance-wide singleton dashboard view and renders it through the same
 * shared DashboardBody used by ProjectDashboardPage and
 * DashboardIntegrationView — admin-scope queries are cross-project (no
 * {{project_id}} placeholder required, see query_guard.go).
 */

import { PluginApiClient, PluginQueryClientProvider } from "@paca-ai/plugin-sdk-react";
import type { AdminPageProps } from "@paca-ai/plugin-sdk-react";
import { LayoutDashboard } from "lucide-react";
import { useAdminDashboardView } from "./api";
import { DashboardBody } from "./DashboardBody";

export default function AdminDashboardPage(props: AdminPageProps) {
  return (
    <PluginQueryClientProvider>
      <Content {...props} />
    </PluginQueryClientProvider>
  );
}

function Content({ api }: AdminPageProps) {
  const viewQuery = useAdminDashboardView(api);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl w-full mx-auto">
      <div>
        <div className="flex items-center gap-2">
          <LayoutDashboard className="size-5 text-primary" />
          <h1 className="text-xl font-semibold">Dashboard — All Projects</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          A single instance-wide dashboard for cross-project panels — build charts, tables, or
          text panels drawing from any project on this instance.
        </p>
      </div>

      {viewQuery.isLoading && <p className="text-sm text-muted-foreground">Loading dashboard…</p>}
      {viewQuery.isError && <p className="text-sm text-destructive">Failed to load the admin dashboard.</p>}
      {viewQuery.data && <DashboardBody api={api} scope="admin" view={viewQuery.data} canEdit />}
    </div>
  );
}
