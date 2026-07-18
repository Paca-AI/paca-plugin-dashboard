/**
 * ProjectOverviewSection — the project-scope body of DashboardPage: status
 * breakdown chart, active sprint progress, story points, and member
 * workload. Split out of DashboardPage.tsx to keep the scope-selection
 * shell and the two very different data-shapes it renders easy to read
 * independently.
 */

import type { PluginApiClient } from "@paca-ai/plugin-sdk-react";
import { StatCard, StatusBreakdownChart, WorkloadBarChart, ProgressBar } from "./widgets";
import { CATEGORY_FALLBACK_COLOR, useProjectOverview } from "./shared";

export default function ProjectOverviewSection({
  api,
  projectId,
}: {
  api: PluginApiClient;
  projectId: string;
}) {
  const { data, isLoading, error } = useProjectOverview(api, projectId);

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

  const statusData = data.status_breakdown.map((s) => ({
    key: s.status_id,
    label: s.status_name,
    color: s.color || CATEGORY_FALLBACK_COLOR[s.category] || "#94a3b8",
    count: s.count,
  }));

  const workloadData = data.workload.map((w) => ({
    key: w.member_id,
    label: w.member_name || w.member_id,
    openCount: w.open_task_count,
    totalCount: w.total_task_count,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Total tasks" value={data.total_tasks} />
        <StatCard label="Story points" value={data.total_story_points} />
        <StatCard
          label="Active sprint"
          value={data.active_sprint ? data.active_sprint.name : "None"}
          sublabel={data.active_sprint ? data.active_sprint.goal || undefined : undefined}
        />
      </div>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 flex items-center gap-2">
          <span>Status breakdown</span>
          <div className="flex-1 h-px bg-linear-to-r from-border/40 to-transparent" />
        </h3>
        <div className="rounded-xl border border-border/25 bg-card/30 p-4">
          <StatusBreakdownChart data={statusData} />
        </div>
      </section>

      {data.active_sprint && (
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 flex items-center gap-2">
            <span>Sprint progress — {data.active_sprint.name}</span>
            <div className="flex-1 h-px bg-linear-to-r from-border/40 to-transparent" />
          </h3>
          <div className="rounded-xl border border-border/25 bg-card/30 p-4 flex flex-col gap-4">
            <ProgressBar
              label="Tasks done"
              percent={data.active_sprint.percent_tasks_done}
              sublabel={`${data.active_sprint.done_tasks}/${data.active_sprint.total_tasks}`}
            />
            <ProgressBar
              label="Story points done"
              percent={data.active_sprint.percent_points_done}
              sublabel={`${data.active_sprint.done_story_points}/${data.active_sprint.total_story_points}`}
            />
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 flex items-center gap-2">
          <span>Member workload</span>
          <div className="flex-1 h-px bg-linear-to-r from-border/40 to-transparent" />
        </h3>
        <div className="rounded-xl border border-border/25 bg-card/30 p-4">
          <WorkloadBarChart data={workloadData} />
        </div>
      </section>
    </div>
  );
}
