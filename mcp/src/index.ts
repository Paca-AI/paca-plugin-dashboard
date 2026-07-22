import {
	PluginAPIClient,
	type PluginMCPContext,
	type PluginMCPEntry,
	type Tool,
	errorResult,
	textResult,
} from "@paca-ai/plugin-sdk-mcp";

// ── Domain types ──────────────────────────────────────────────────────────────
// Mirror the backend's dashboardView/dashboardPanel JSON encodings (see
// backend/types.go, views.go, panels.go) field for field.

type PanelType = "chart" | "table" | "text";
type ChartType = "bar" | "line" | "donut";

interface DashboardPanel {
	id: string;
	dashboard_view_id: string;
	type: PanelType;
	title: string;
	query?: string | null;
	chart_type?: ChartType | null;
	content?: string | null;
	viz_config: Record<string, unknown>;
	pos_x: number;
	pos_y: number;
	width: number;
	height: number;
	created_at: string;
	updated_at: string;
}

interface DashboardView {
	id: string;
	project_id?: string | null;
	scope: "project" | "admin" | "integration";
	host_view_id?: string | null;
	name: string;
	panels: DashboardPanel[];
	created_at: string;
	updated_at: string;
}

interface QueryResult {
	columns: string[];
	rows: Record<string, unknown>[];
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatPanel(panel: DashboardPanel): string {
	const lines = [
		`- ${panel.title} (${panel.type}${panel.chart_type ? `/${panel.chart_type}` : ""})`,
		`  ID: ${panel.id}`,
		`  Position: x=${panel.pos_x}, y=${panel.pos_y}, width=${panel.width}, height=${panel.height}`,
	];
	if (panel.query) {
		lines.push(`  Query: ${panel.query}`);
	}
	if (panel.content) {
		lines.push(`  Content: ${panel.content}`);
	}
	return lines.join("\n");
}

function formatView(view: DashboardView): string {
	const header = [
		`Dashboard: ${view.name}`,
		`ID: ${view.id}`,
		`Scope: ${view.scope}`,
		view.host_view_id ? `Host view: ${view.host_view_id}` : null,
	]
		.filter(Boolean)
		.join("\n");

	if (view.panels.length === 0) {
		return `${header}\n\nNo panels yet.`;
	}

	const panels = view.panels.map(formatPanel).join("\n\n");
	return `${header}\n\nPanels (${view.panels.length}):\n\n${panels}`;
}

const MAX_PREVIEW_ROWS = 25;

function formatQueryResult(result: QueryResult): string {
	if (result.rows.length === 0) {
		return `Columns: ${result.columns.join(", ")}\n(no rows)`;
	}
	const shown = result.rows.slice(0, MAX_PREVIEW_ROWS);
	const header = `| ${result.columns.join(" | ")} |`;
	const separator = `| ${result.columns.map(() => "---").join(" | ")} |`;
	const body = shown
		.map((row) => `| ${result.columns.map((c) => formatCell(row[c])).join(" | ")} |`)
		.join("\n");
	const truncation =
		result.rows.length > MAX_PREVIEW_ROWS
			? `\n\n(showing ${MAX_PREVIEW_ROWS} of ${result.rows.length} rows)`
			: "";
	return `${header}\n${separator}\n${body}${truncation}`;
}

function formatCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const projectIdProp = {
	type: "string",
	description:
		"The technical UUID of the project (e.g., '550e8400-e29b-41d4-a716-446655440000'). Use list_projects to get the project ID.",
};

const viewIdProp = {
	type: "string",
	description:
		"The technical UUID of the dashboard view. Use dashboard_get_view (or dashboard_get_admin_view) to get this ID.",
};

const panelTypeProp = {
	type: "string",
	enum: ["chart", "table", "text"],
	description:
		"Panel type. 'chart' and 'table' both run a SQL query; 'text' is static content with no query.",
};

const chartTypeProp = {
	type: "string",
	enum: ["bar", "line", "donut"],
	description: "Required when type is 'chart'. Ignored for 'table'/'text'.",
};

const queryProp = {
	type: "string",
	description:
		"Required when type is 'chart' or 'table'. A single read-only SELECT (or WITH ... SELECT) statement — see the paca-dashboard-builder skill for the full query safety model (forbidden keywords, the {{project_id}} placeholder, and curated preset queries to start from). Not used for 'text' panels.",
};

const contentProp = {
	type: "string",
	description: "Required when type is 'text'. Plain text/markdown content for the panel. Not used for 'chart'/'table' panels.",
};

const vizConfigProp = {
	type: "object",
	description: "Optional free-form display options blob (axis labels, colors, etc.). Defaults to {}.",
};

const posXProp = { type: "number", description: "Grid column (0-based). Defaults to 0." };
const posYProp = { type: "number", description: "Grid row (0-based). Defaults to 0." };
const widthProp = { type: "number", description: "Width in grid cells (12-column grid). Defaults to 4." };
const heightProp = { type: "number", description: "Height in grid cells. Defaults to 3." };

const panelIdProp = {
	type: "string",
	description: "The technical UUID of the panel. Use dashboard_get_view (or dashboard_get_admin_view) to get panel IDs.",
};

const refreshProp = {
	type: "boolean",
	description:
		"If true, bypass the cached result and re-run the query now. Panel results are cached for up to 5 minutes after each run; omit or set false to reuse a recent cached result when one exists.",
};

const layoutPanelsProp = {
	type: "array",
	description: "One entry per panel being moved/resized. Panels not listed are left unchanged.",
	items: {
		type: "object",
		properties: {
			id: { type: "string", description: "Panel UUID." },
			posX: { type: "number", description: "Grid column (0-based)." },
			posY: { type: "number", description: "Grid row (0-based)." },
			width: { type: "number", description: "Width in grid cells." },
			height: { type: "number", description: "Height in grid cells." },
		},
		required: ["id", "posX", "posY", "width", "height"],
	},
};

const tools: Tool[] = [
	// ── Project / integration scope ─────────────────────────────────────────
	{
		name: "dashboard_get_view",
		description:
			"Get a project or integration dashboard, including all its panels (panel metadata only — use dashboard_get_panel_data for a panel's actual query results). Omit both viewId and hostViewId to get-or-create the project's own singleton dashboard (created empty on first call). Pass hostViewId to get-or-create the dashboard bound to a specific host Backlog/Sprint/Timeline view. Pass viewId to reload a dashboard you already resolved by ID (fastest — no scope resolution needed).",
		inputSchema: {
			type: "object",
			properties: {
				projectId: projectIdProp,
				viewId: { ...viewIdProp, description: "Optional: " + viewIdProp.description },
				hostViewId: {
					type: "string",
					description:
						"Optional: the host's own interaction-view ID for a 'Dashboard'-type view added via the Backlog/Sprint/Timeline 'Add view' popover. Ignored if viewId is set.",
				},
			},
			required: ["projectId"],
		},
	},
	{
		name: "dashboard_preview_query",
		description:
			"Validate and run a not-yet-saved SQL query against a project's data, returning the result rows. Use this before dashboard_create_panel/dashboard_update_panel to confirm a query is valid and shows the data you expect.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: projectIdProp,
				query: queryProp,
			},
			required: ["projectId", "query"],
		},
	},
	{
		name: "dashboard_create_panel",
		description:
			"Create a new panel (chart, table, or text) on a project or integration dashboard. Chart panels require chartType and query; table panels require query; text panels require content.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: projectIdProp,
				viewId: viewIdProp,
				type: panelTypeProp,
				title: { type: "string", description: "Panel title, shown in its header." },
				query: queryProp,
				chartType: chartTypeProp,
				content: contentProp,
				vizConfig: vizConfigProp,
				posX: posXProp,
				posY: posYProp,
				width: widthProp,
				height: heightProp,
			},
			required: ["projectId", "viewId", "type", "title"],
		},
	},
	{
		name: "dashboard_update_panel",
		description:
			"Replace an existing panel's type/title/query/chartType/content/vizConfig. This is a full replace, not a partial patch — resend every field the panel should keep (e.g. include the existing title if you're only changing the query), following the same per-type requirements as dashboard_create_panel. Panel position/size is not affected; use dashboard_update_panel_layout for that.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: projectIdProp,
				viewId: viewIdProp,
				panelId: panelIdProp,
				type: panelTypeProp,
				title: { type: "string", description: "Panel title, shown in its header." },
				query: queryProp,
				chartType: chartTypeProp,
				content: contentProp,
				vizConfig: vizConfigProp,
			},
			required: ["projectId", "viewId", "panelId", "type", "title"],
		},
	},
	{
		name: "dashboard_delete_panel",
		description: "Delete a panel from a project or integration dashboard.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: projectIdProp,
				viewId: viewIdProp,
				panelId: panelIdProp,
			},
			required: ["projectId", "viewId", "panelId"],
		},
	},
	{
		name: "dashboard_update_panel_layout",
		description:
			"Bulk-update the grid position/size of one or more panels on a project or integration dashboard (e.g. after arranging a new panel or rebalancing a crowded row).",
		inputSchema: {
			type: "object",
			properties: {
				projectId: projectIdProp,
				viewId: viewIdProp,
				panels: layoutPanelsProp,
			},
			required: ["projectId", "viewId", "panels"],
		},
	},
	{
		name: "dashboard_get_panel_data",
		description:
			"Run a saved chart/table panel's query and return the result rows (text panels have no data — this will error). Results are cached for up to 5 minutes; pass refresh=true to force a fresh run, e.g. after editing the panel's query.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: projectIdProp,
				viewId: viewIdProp,
				panelId: panelIdProp,
				refresh: refreshProp,
			},
			required: ["projectId", "viewId", "panelId"],
		},
	},

	// ── Admin scope ──────────────────────────────────────────────────────────
	{
		name: "dashboard_get_admin_view",
		description:
			"Get the single instance-wide admin dashboard, including all its panels (created empty on first call). Requires the caller to hold the users.write (admin) permission.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "dashboard_preview_admin_query",
		description:
			"Validate and run a not-yet-saved cross-project SQL query for the admin dashboard, returning the result rows. Use this before dashboard_create_admin_panel/dashboard_update_admin_panel.",
		inputSchema: {
			type: "object",
			properties: { query: queryProp },
			required: ["query"],
		},
	},
	{
		name: "dashboard_create_admin_panel",
		description:
			"Create a new panel (chart, table, or text) on the admin dashboard. Chart panels require chartType and query; table panels require query; text panels require content. Admin queries are cross-project and must NOT use the {{project_id}} placeholder.",
		inputSchema: {
			type: "object",
			properties: {
				type: panelTypeProp,
				title: { type: "string", description: "Panel title, shown in its header." },
				query: queryProp,
				chartType: chartTypeProp,
				content: contentProp,
				vizConfig: vizConfigProp,
				posX: posXProp,
				posY: posYProp,
				width: widthProp,
				height: heightProp,
			},
			required: ["type", "title"],
		},
	},
	{
		name: "dashboard_update_admin_panel",
		description:
			"Replace an existing admin dashboard panel's type/title/query/chartType/content/vizConfig. This is a full replace, not a partial patch — resend every field the panel should keep, following the same per-type requirements as dashboard_create_admin_panel.",
		inputSchema: {
			type: "object",
			properties: {
				panelId: panelIdProp,
				type: panelTypeProp,
				title: { type: "string", description: "Panel title, shown in its header." },
				query: queryProp,
				chartType: chartTypeProp,
				content: contentProp,
				vizConfig: vizConfigProp,
			},
			required: ["panelId", "type", "title"],
		},
	},
	{
		name: "dashboard_delete_admin_panel",
		description: "Delete a panel from the admin dashboard.",
		inputSchema: {
			type: "object",
			properties: { panelId: panelIdProp },
			required: ["panelId"],
		},
	},
	{
		name: "dashboard_update_admin_panel_layout",
		description: "Bulk-update the grid position/size of one or more panels on the admin dashboard.",
		inputSchema: {
			type: "object",
			properties: { panels: layoutPanelsProp },
			required: ["panels"],
		},
	},
	{
		name: "dashboard_get_admin_panel_data",
		description:
			"Run a saved admin dashboard chart/table panel's query and return the result rows (text panels have no data — this will error). Results are cached for up to 5 minutes; pass refresh=true to force a fresh run.",
		inputSchema: {
			type: "object",
			properties: {
				panelId: panelIdProp,
				refresh: refreshProp,
			},
			required: ["panelId"],
		},
	},
];

// ── Panel body builder ───────────────────────────────────────────────────────
// Shared by create/update for both scopes — maps camelCase tool args onto the
// backend's snake_case panelBody JSON shape (see backend/panels.go).

interface PanelArgs {
	type: PanelType;
	title: string;
	query?: string;
	chartType?: ChartType;
	content?: string;
	vizConfig?: Record<string, unknown>;
	posX?: number;
	posY?: number;
	width?: number;
	height?: number;
}

function buildPanelBody(args: PanelArgs): Record<string, unknown> {
	const body: Record<string, unknown> = { type: args.type, title: args.title };
	if (args.query !== undefined) body.query = args.query;
	if (args.chartType !== undefined) body.chart_type = args.chartType;
	if (args.content !== undefined) body.content = args.content;
	if (args.vizConfig !== undefined) body.viz_config = args.vizConfig;
	if (args.posX !== undefined) body.pos_x = args.posX;
	if (args.posY !== undefined) body.pos_y = args.posY;
	if (args.width !== undefined) body.width = args.width;
	if (args.height !== undefined) body.height = args.height;
	return body;
}

interface LayoutEntryArgs {
	id: string;
	posX: number;
	posY: number;
	width: number;
	height: number;
}

function buildLayoutBody(panels: LayoutEntryArgs[]): { panels: Record<string, unknown>[] } {
	return {
		panels: panels.map((p) => ({
			id: p.id,
			pos_x: p.posX,
			pos_y: p.posY,
			width: p.width,
			height: p.height,
		})),
	};
}

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
				// ── Project / integration scope ───────────────────────────────
				case "dashboard_get_view": {
					const { projectId, viewId, hostViewId } = args as {
						projectId: string;
						viewId?: string;
						hostViewId?: string;
					};
					const path = viewId
						? `projects/${projectId}/dashboard/views/${viewId}`
						: hostViewId
							? `projects/${projectId}/dashboard/view/${hostViewId}`
							: `projects/${projectId}/dashboard/view`;
					const view = await api.pluginGet<DashboardView>(path);
					return textResult(formatView(view));
				}

				case "dashboard_preview_query": {
					const { projectId, query } = args as { projectId: string; query: string };
					const result = await api.pluginPost<QueryResult>(
						`projects/${projectId}/dashboard/query/preview`,
						{ query },
					);
					return textResult(formatQueryResult(result));
				}

				case "dashboard_create_panel": {
					const { projectId, viewId, ...panelArgs } = args as unknown as PanelArgs & {
						projectId: string;
						viewId: string;
					};
					const panel = await api.pluginPost<DashboardPanel>(
						`projects/${projectId}/dashboard/views/${viewId}/panels`,
						buildPanelBody(panelArgs),
					);
					return textResult(`Panel created:\n\n${formatPanel(panel)}`);
				}

				case "dashboard_update_panel": {
					const { projectId, viewId, panelId, ...panelArgs } = args as unknown as PanelArgs & {
						projectId: string;
						viewId: string;
						panelId: string;
					};
					const panel = await api.pluginPatch<DashboardPanel>(
						`projects/${projectId}/dashboard/views/${viewId}/panels/${panelId}`,
						buildPanelBody(panelArgs),
					);
					return textResult(`Panel updated:\n\n${formatPanel(panel)}`);
				}

				case "dashboard_delete_panel": {
					const { projectId, viewId, panelId } = args as {
						projectId: string;
						viewId: string;
						panelId: string;
					};
					await api.pluginDelete(
						`projects/${projectId}/dashboard/views/${viewId}/panels/${panelId}`,
					);
					return textResult(`Panel ${panelId} deleted successfully.`);
				}

				case "dashboard_update_panel_layout": {
					const { projectId, viewId, panels } = args as {
						projectId: string;
						viewId: string;
						panels: LayoutEntryArgs[];
					};
					await api.pluginPatch(
						`projects/${projectId}/dashboard/views/${viewId}/panels/layout`,
						buildLayoutBody(panels),
					);
					return textResult(`Layout updated for ${panels.length} panel(s).`);
				}

				case "dashboard_get_panel_data": {
					const { projectId, viewId, panelId, refresh } = args as {
						projectId: string;
						viewId: string;
						panelId: string;
						refresh?: boolean;
					};
					const path = `projects/${projectId}/dashboard/views/${viewId}/panels/${panelId}/data${refresh ? "?refresh=true" : ""}`;
					const result = await api.pluginPost<QueryResult>(path, {});
					return textResult(formatQueryResult(result));
				}

				// ── Admin scope ────────────────────────────────────────────────
				case "dashboard_get_admin_view": {
					const view = await api.pluginGet<DashboardView>("dashboard/admin-view");
					return textResult(formatView(view));
				}

				case "dashboard_preview_admin_query": {
					const { query } = args as { query: string };
					const result = await api.pluginPost<QueryResult>(
						"dashboard/admin-query/preview",
						{ query },
					);
					return textResult(formatQueryResult(result));
				}

				case "dashboard_create_admin_panel": {
					const panelArgs = args as unknown as PanelArgs;
					const panel = await api.pluginPost<DashboardPanel>(
						"dashboard/admin-view/panels",
						buildPanelBody(panelArgs),
					);
					return textResult(`Panel created:\n\n${formatPanel(panel)}`);
				}

				case "dashboard_update_admin_panel": {
					const { panelId, ...panelArgs } = args as unknown as PanelArgs & { panelId: string };
					const panel = await api.pluginPatch<DashboardPanel>(
						`dashboard/admin-view/panels/${panelId}`,
						buildPanelBody(panelArgs),
					);
					return textResult(`Panel updated:\n\n${formatPanel(panel)}`);
				}

				case "dashboard_delete_admin_panel": {
					const { panelId } = args as { panelId: string };
					await api.pluginDelete(`dashboard/admin-view/panels/${panelId}`);
					return textResult(`Panel ${panelId} deleted successfully.`);
				}

				case "dashboard_update_admin_panel_layout": {
					const { panels } = args as { panels: LayoutEntryArgs[] };
					await api.pluginPatch(
						"dashboard/admin-view/panels/layout",
						buildLayoutBody(panels),
					);
					return textResult(`Layout updated for ${panels.length} panel(s).`);
				}

				case "dashboard_get_admin_panel_data": {
					const { panelId, refresh } = args as { panelId: string; refresh?: boolean };
					const path = `dashboard/admin-view/panels/${panelId}/data${refresh ? "?refresh=true" : ""}`;
					const result = await api.pluginPost<QueryResult>(path, {});
					return textResult(formatQueryResult(result));
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
