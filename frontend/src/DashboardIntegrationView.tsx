/**
 * DashboardIntegrationView.tsx — the component registered at the host's
 * `view` extension point (see plugin.json's "view" entry). Each "Dashboard"
 * view created via the host's own "Add view" popover in Backlog/Sprint/
 * Timeline gets exactly one dashboard, get-or-created and keyed by the
 * host's own view id (props.viewId) — same singleton shape as
 * ProjectDashboardPage/AdminDashboardPage, just resolved through the
 * `/dashboard/view/:hostViewId` endpoint instead of `/dashboard/view` or
 * `/dashboard/admin-view`. No in-plugin list/create/rename/delete: if you
 * want another dashboard, create another "Dashboard" view from the host.
 */

import { PluginQueryClientProvider } from "@paca-ai/plugin-sdk-react";
import type { ViewExtensionProps } from "@paca-ai/plugin-sdk-react";
import { useIntegrationDashboardView } from "./api";
import { DashboardBody } from "./DashboardBody";

export default function DashboardIntegrationView(props: ViewExtensionProps) {
  return (
    <PluginQueryClientProvider>
      <Content {...props} />
    </PluginQueryClientProvider>
  );
}

function Content({ api, viewId }: ViewExtensionProps) {
  const viewQuery = useIntegrationDashboardView(api, viewId);

  if (viewQuery.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading dashboard…</p>;
  }
  if (viewQuery.isError) {
    return <p className="p-4 text-sm text-destructive">Failed to load this dashboard.</p>;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {viewQuery.data && (
        <DashboardBody api={api} scope="integration" view={viewQuery.data} canEdit />
      )}
    </div>
  );
}
