/**
 * DashboardBody.tsx — the scope-agnostic body rendered once a DashboardView
 * (with its panels) is loaded, shared by ProjectDashboardPage,
 * AdminDashboardPage, and DashboardIntegrationView. Owns: panel data
 * fetch-on-mount + manual refresh, the add/edit panel modal, and layout
 * commits.
 *
 * Fetch policy: each chart/table panel's data is fetched once on mount
 * (not on every render/poll) and again only when the user hits a panel's
 * refresh button or edits/saves it — dashboards here are operational
 * snapshots, not live-streaming, and re-running arbitrary SQL on every
 * poll tick would be wasteful against the shared Postgres. The backend
 * additionally caches each panel's last result for 5 minutes; the mount
 * fetch is fine reading a cache hit, but the refresh button always forces
 * a bypass (forceRefresh=true) so it never just re-hands-back stale data.
 */

import { useEffect, useState } from "react";
import type { PluginApiClient } from "@paca-ai/plugin-sdk-react";
import { Plus } from "lucide-react";
import "./lib/i18n";
import type { DashboardPanel, DashboardScopeKind, DashboardView, PanelInput, QueryResult } from "./types";
import {
  useCreatePanel,
  useDeletePanel,
  usePanelDataFetcher,
  useQueryPreview,
  useUpdatePanel,
  useUpdatePanelLayout,
} from "./api";
import { PanelGrid } from "./PanelGrid";
import { PanelEditor } from "./PanelEditor";

interface DashboardBodyProps {
  api: PluginApiClient;
  scope: DashboardScopeKind;
  view: DashboardView;
  canEdit: boolean;
}

export function DashboardBody({ api, scope, view, canEdit }: DashboardBodyProps) {
  const createPanel = useCreatePanel(api, scope, view.id);
  const updatePanel = useUpdatePanel(api, scope, view.id);
  const deletePanel = useDeletePanel(api, scope, view.id);
  const updateLayout = useUpdatePanelLayout(api, scope, view.id);
  const fetchPanelData = usePanelDataFetcher(api, scope, view.id);
  const queryPreview = useQueryPreview(api, scope);

  const [editingPanel, setEditingPanel] = useState<DashboardPanel | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [results, setResults] = useState<Record<string, QueryResult | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());

  // Each call is an independent promise (not a shared mutation observer),
  // so firing this concurrently for every panel on mount doesn't drop
  // earlier panels' callbacks — see usePanelDataFetcher's doc comment.
  //
  // forceRefresh bypasses the backend's panel-data cache: the mount-time
  // auto-fetch below omits it (a cache hit there is fine — this fires on
  // every render where a panel has no result yet), but the reload button
  // (wired to onRunQuery further down) always passes true, since a user
  // hitting reload expects to see past-the-cache, live data.
  const runQuery = (panel: DashboardPanel, forceRefresh = false) => {
    if (panel.type === "text") return;
    setLoadingIds((prev) => new Set(prev).add(panel.id));
    setErrors((prev) => ({ ...prev, [panel.id]: undefined }));
    fetchPanelData(panel.id, forceRefresh)
      .then((data) => setResults((prev) => ({ ...prev, [panel.id]: data })))
      .catch((err) =>
        setErrors((prev) => ({ ...prev, [panel.id]: err instanceof Error ? err.message : "Query failed" })),
      )
      .finally(() =>
        setLoadingIds((prev) => {
          const next = new Set(prev);
          next.delete(panel.id);
          return next;
        }),
      );
  };

  // Fetch every chart/table panel's data once on initial mount / whenever
  // the panel id list changes (e.g. a new panel was added).
  const panelIdsKey = view.panels.map((p) => p.id).join(",");
  useEffect(() => {
    for (const panel of view.panels) {
      if (panel.type !== "text" && !(panel.id in results)) {
        runQuery(panel);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelIdsKey]);

  const handleSavePanel = (input: PanelInput) => {
    if (editingPanel) {
      updatePanel.mutate(
        { panelId: editingPanel.id, panel: input },
        { onSuccess: () => setEditingPanel(null) },
      );
    } else {
      createPanel.mutate(input, { onSuccess: () => setIsCreating(false) });
    }
  };

  const handleDeletePanel = (panel: DashboardPanel) => {
    deletePanel.mutate(panel.id);
  };

  const editorOpen = isCreating || editingPanel !== null;

  return (
    <div className="flex flex-col gap-4">
      {canEdit && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-3.5" />
            Add panel
          </button>
        </div>
      )}

      <PanelGrid
        panels={view.panels}
        canEdit={canEdit}
        onLayoutCommit={(entries) => updateLayout.mutate(entries)}
        onEditPanel={setEditingPanel}
        onDeletePanel={handleDeletePanel}
        onRunQuery={(panel) => runQuery(panel, true)}
        queryResultsByPanelId={results}
        loadingPanelIds={loadingIds}
        errorsByPanelId={errors}
      />

      {editorOpen && (
        <PanelEditor
          scope={scope}
          panel={editingPanel}
          saving={createPanel.isPending || updatePanel.isPending}
          onCancel={() => {
            setIsCreating(false);
            setEditingPanel(null);
          }}
          onSave={handleSavePanel}
          onPreview={(query) => queryPreview.mutateAsync(query)}
        />
      )}
    </div>
  );
}
