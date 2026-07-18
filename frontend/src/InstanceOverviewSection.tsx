/**
 * InstanceOverviewSection — the admin-scope body of DashboardPage:
 * cross-project stat cards plus a per-project task-count table. Split out
 * of DashboardPage.tsx for the same reason as ProjectOverviewSection.
 */

import type { PluginApiClient } from "@paca-ai/plugin-sdk-react";
import { StatCard } from "./widgets";
import { useInstanceOverview } from "./shared";

export default function InstanceOverviewSection({ api }: { api: PluginApiClient }) {
  const { data, isLoading, error } = useInstanceOverview(api);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading dashboard…</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load dashboard: {error.message}
      </p>
    );
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Projects" value={data.project_count} />
        <StatCard label="Total tasks" value={data.total_tasks} />
        <StatCard label="Open tasks" value={data.total_open_tasks} />
      </div>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 flex items-center gap-2">
          <span>Per-project breakdown</span>
          <div className="flex-1 h-px bg-linear-to-r from-border/40 to-transparent" />
        </h3>
        {data.projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects yet.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/25">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/25 bg-card/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">
                  <th className="px-4 py-2">Project</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right">Open</th>
                  <th className="px-4 py-2 text-right">Done</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => (
                  <tr key={p.project_id} className="border-b border-border/10 last:border-0">
                    <td className="px-4 py-2">{p.project_name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{p.total_tasks}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{p.open_tasks}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{p.done_tasks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
