/**
 * types.ts — response shapes for the dashboard plugin's two read-only
 * aggregation endpoints. These mirror the backend's projectOverviewData /
 * instanceOverviewData JSON encodings (see backend/overview.go) field for
 * field, snake_case to match the host's JSON envelope convention.
 */

export interface StatusCount {
  status_id: string;
  status_name: string;
  color: string;
  category: string;
  count: number;
}

export interface SprintProgress {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  goal: string;
  total_tasks: number;
  done_tasks: number;
  total_story_points: number;
  done_story_points: number;
  percent_tasks_done: number;
  percent_points_done: number;
}

export interface WorkloadEntry {
  member_id: string;
  member_name: string;
  open_task_count: number;
  total_task_count: number;
}

/** Response shape of GET /projects/:projectId/dashboard/overview. */
export interface ProjectOverview {
  total_tasks: number;
  total_story_points: number;
  status_breakdown: StatusCount[];
  active_sprint: SprintProgress | null;
  workload: WorkloadEntry[];
}

export interface ProjectSummaryRow {
  project_id: string;
  project_name: string;
  total_tasks: number;
  open_tasks: number;
  done_tasks: number;
}

/** Response shape of GET /dashboard/overview-all (admin scope). */
export interface InstanceOverview {
  project_count: number;
  total_tasks: number;
  total_open_tasks: number;
  projects: ProjectSummaryRow[];
}
