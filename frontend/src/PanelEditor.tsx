/**
 * PanelEditor.tsx — modal for creating/editing a chart/table/text panel.
 * Built on Paca's actual shared Dialog primitive (ported into
 * src/components/ui/dialog.tsx from apps/web/src/components/ui/dialog.tsx —
 * same component behind task-detail's dialogs, RoleFormDialog, etc.), so
 * outside-click dismissal, Escape, focus trap, and animations all match the
 * host exactly instead of being hand-rolled. The scrollable-body-on-small-
 * screens treatment (`flex flex-col ... max-h-[90svh]` + inner
 * `overflow-y-auto min-h-0`) mirrors RoleFormDialog.tsx / ProjectRoleFormDialog.tsx,
 * the host's own pattern for dialogs whose content can exceed viewport height.
 *
 * Query-safety UX: the SQL textarea shows the {{project_id}} placeholder
 * requirement inline (project/integration scope only), and any 400 from
 * the backend's query guard (see backend/query_guard.go) is surfaced
 * verbatim under a "Preview" button before Save is even attempted.
 */

import { useState } from "react";
import { Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import type { DashboardPanel, DashboardScopeKind, PanelInput, ChartType, PanelType, QueryResult } from "./types";
import { presetsForScopeAndType, type QueryPreset } from "./presets";

interface PanelEditorProps {
  scope: DashboardScopeKind;
  panel: DashboardPanel | null; // null = create mode
  onSave: (input: PanelInput) => void;
  onCancel: () => void;
  onPreview: (query: string) => Promise<QueryResult>;
  saving: boolean;
}

export function PanelEditor({ scope, panel, onSave, onCancel, onPreview, saving }: PanelEditorProps) {
  const [type, setType] = useState<PanelType>(panel?.type ?? "chart");
  const [title, setTitle] = useState(panel?.title ?? "");
  const [chartType, setChartType] = useState<ChartType>((panel?.chart_type as ChartType) ?? "bar");
  const [query, setQuery] = useState(panel?.query ?? "");
  const [content, setContent] = useState(panel?.content ?? "");
  const [previewResult, setPreviewResult] = useState<QueryResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [appliedPresetId, setAppliedPresetId] = useState<string | null>(null);

  const needsQuery = type === "chart" || type === "table";
  const isProjectScoped = scope !== "admin";
  const availablePresets = needsQuery ? presetsForScopeAndType(scope, type) : [];

  const applyPreset = (preset: QueryPreset) => {
    setType(preset.panelType);
    if (preset.chartType) setChartType(preset.chartType);
    setQuery(preset.query);
    if (!title.trim()) setTitle(preset.title);
    setAppliedPresetId(preset.id);
    setPreviewResult(null);
    setPreviewError(null);
  };

  const runPreview = async () => {
    setPreviewing(true);
    setPreviewError(null);
    setPreviewResult(null);
    try {
      const result = await onPreview(query);
      setPreviewResult(result);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Query failed");
    } finally {
      setPreviewing(false);
    }
  };

  const canSave = title.trim() !== "" && (!needsQuery || query.trim() !== "") && (type !== "text" || content.trim() !== "");

  const submit = () => {
    if (!canSave) return;
    const input: PanelInput = {
      type,
      title: title.trim(),
      query: needsQuery ? query.trim() : null,
      chart_type: type === "chart" ? chartType : null,
      content: type === "text" ? content : null,
    };
    onSave(input);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="flex flex-col sm:max-w-lg max-h-[90svh]">
        <DialogHeader>
          <DialogTitle>{panel ? "Edit panel" : "Add panel"}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col gap-4 py-1">
          <Field label="Title">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Panel title"
              className="w-full rounded-md border border-border/30 bg-card/30 px-2.5 py-1.5 text-sm outline-none focus:border-primary/50"
            />
          </Field>

          {!panel && (
            <Field label="Panel type">
              <div className="flex gap-2">
                {(["chart", "table", "text"] as PanelType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setType(t);
                      setAppliedPresetId(null);
                    }}
                    className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium capitalize transition-colors ${
                      type === t
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border/30 text-muted-foreground hover:bg-muted/30"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {!panel && needsQuery && availablePresets.length > 0 && (
            <Field
              label="Start from a preset"
              hint="Fills in title, chart type, and a ready-to-run SQL query — edit it however you like afterwards."
            >
              <div className="flex flex-col gap-1.5">
                {availablePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors ${
                      appliedPresetId === preset.id
                        ? "border-primary/50 bg-primary/10"
                        : "border-border/30 hover:bg-muted/30"
                    }`}
                  >
                    <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary/70" />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-foreground">{preset.title}</span>
                      <span className="block text-xs text-muted-foreground/80">{preset.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Field>
          )}

          {type === "chart" && (
            <Field label="Chart type">
              <div className="flex gap-2">
                {(["bar", "line", "donut"] as ChartType[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setChartType(c)}
                    className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium capitalize transition-colors ${
                      chartType === c
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border/30 text-muted-foreground hover:bg-muted/30"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {needsQuery && (
            <Field
              label="SQL query"
              hint={
                isProjectScoped
                  ? 'Must include the literal placeholder "{{project_id}}" in a WHERE/ON/HAVING clause — the backend rejects project-scoped queries without it (see query safety rules).'
                  : "Admin-scope queries are cross-project — no project_id placeholder needed."
              }
            >
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                rows={5}
                placeholder={
                  isProjectScoped
                    ? "SELECT status, COUNT(*) FROM tasks WHERE project_id = {{project_id}} GROUP BY status"
                    : "SELECT name, COUNT(*) FROM projects p JOIN tasks t ON t.project_id = p.id GROUP BY name"
                }
                className="w-full resize-y rounded-md border border-border/30 bg-card/30 px-2.5 py-2 font-mono text-xs outline-none focus:border-primary/50"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={runPreview}
                  disabled={query.trim() === "" || previewing}
                  className="rounded-md border border-border/30 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted/30 disabled:opacity-40"
                >
                  {previewing ? "Running…" : "Preview"}
                </button>
                {previewResult && (
                  <span className="text-xs text-muted-foreground">
                    {previewResult.rows.length} row{previewResult.rows.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              {previewError && <p className="mt-1.5 text-xs text-destructive">{previewError}</p>}
              {previewResult && !previewError && (
                <div className="mt-2 max-h-32 overflow-auto rounded-md border border-border/20 bg-card/20 p-2">
                  <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
                    {JSON.stringify(previewResult.rows.slice(0, 5), null, 1)}
                  </pre>
                </div>
              )}
            </Field>
          )}

          {type === "text" && (
            <Field label="Content">
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={5}
                placeholder="Write any text/markdown-ish note for this panel…"
                className="w-full resize-y rounded-md border border-border/30 bg-card/30 px-2.5 py-2 text-sm outline-none focus:border-primary/50"
              />
            </Field>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSave || saving}>
            {saving ? "Saving…" : panel ? "Save changes" : "Add panel"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-semibold text-foreground/90">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground/80">{hint}</p>}
    </div>
  );
}
