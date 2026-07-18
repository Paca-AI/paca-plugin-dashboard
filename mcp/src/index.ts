import {
	PluginAPIClient,
	type PluginMCPContext,
	type PluginMCPEntry,
	type Tool,
	errorResult,
	textResult,
} from "@paca-ai/plugin-sdk-mcp";

// ── Domain types ──────────────────────────────────────────────────────────────
// Mirror the backend's projectOverviewData / instanceOverviewData JSON shapes
// (see backend/overview.go).

interface StatusCount {
	status_id: string;
	status_name: string;
	color: string;
	category: string;
	count: number;
}

interface SprintProgress {
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

interface WorkloadEntry {
	member_id: string;
	member_name: string;
	open_task_count: number;
	total_task_count: number;
}

interface ProjectOverview {
	total_tasks: number;
	total_story_points: number;
	status_breakdown: StatusCount[];
	active_sprint: SprintProgress | null;
	workload: WorkloadEntry[];
}

interface ProjectSummaryRow {
	project_id: string;
	project_name: string;
	total_tasks: number;
	open_tasks: number;
	done_tasks: number;
}

interface InstanceOverview {
	project_count: number;
	total_tasks: number;
	total_open_tasks: number;
	projects: ProjectSummaryRow[];
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatProjectOverview(o: ProjectOverview): string {
	const lines: string[] = [
		`Total tasks: ${o.total_tasks} (${o.total_story_points} story points)`,
		"",
		"Status breakdown:",
		...o.status_breakdown.map((s) => `  ${s.status_name}: ${s.count}`),
	];

	if (o.active_sprint) {
		const s = o.active_sprint;
		lines.push(
			"",
			`Active sprint: ${s.name}${s.goal ? ` — ${s.goal}` : ""}`,
			`  Tasks: ${s.done_tasks}/${s.total_tasks} done (${s.percent_tasks_done}%)`,
			`  Story points: ${s.done_story_points}/${s.total_story_points} done (${s.percent_points_done}%)`,
		);
	} else {
		lines.push("", "No active sprint.");
	}

	if (o.workload.length > 0) {
		lines.push(
			"",
			"Member workload (open/total assigned tasks):",
			...o.workload.map(
				(w) => `  ${w.member_name || w.member_id}: ${w.open_task_count}/${w.total_task_count}`,
			),
		);
	}

	return lines.join("\n");
}

function formatInstanceOverview(o: InstanceOverview): string {
	if (o.projects.length === 0) {
		return "No projects yet.";
	}
	const lines: string[] = [
		`${o.project_count} project(s), ${o.total_tasks} total tasks (${o.total_open_tasks} open)`,
		"",
		"Per-project breakdown:",
		...o.projects.map(
			(p) =>
				`  ${p.project_name}: ${p.total_tasks} total, ${p.open_tasks} open, ${p.done_tasks} done`,
		),
	];
	return lines.join("\n");
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const UUID_DESC =
	"The technical UUID of the %s (e.g., '550e8400-e29b-41d4-a716-446655440000').";

const tools: Tool[] = [
	{
		name: "dashboard_project_overview",
		description:
			"Get an at-a-glance dashboard for a project: task status breakdown, active sprint progress, story points, and member workload.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: UUID_DESC.replace("%s", "project") + " Use list_projects to get the project ID.",
				},
			},
			required: ["projectId"],
		},
	},
	{
		name: "dashboard_instance_overview",
		description:
			"Get a cross-project dashboard summarizing task counts across every project on this instance. Requires the caller to hold the users.write (admin) permission.",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
];

// ── Entry ─────────────────────────────────────────────────────────────────────

const entry: PluginMCPEntry = {
	tools,

	async handleToolCall(
		name: string,
		args: Record<string, unknown>,
		context: PluginMCPContext,
	) {
		const api = new PluginAPIClient(context);

		try {
			switch (name) {
				case "dashboard_project_overview": {
					const { projectId } = args as { projectId: string };
					const overview = await api.pluginGet<ProjectOverview>(
						`projects/${projectId}/dashboard/overview`,
					);
					return textResult(formatProjectOverview(overview));
				}

				case "dashboard_instance_overview": {
					const overview = await api.pluginGet<InstanceOverview>(
						"dashboard/overview-all",
					);
					return textResult(formatInstanceOverview(overview));
				}

				default:
					return errorResult(`Unknown tool: ${name}`);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return errorResult(`Tool ${name} failed: ${message}`);
		}
	},
};

export default entry;
