-- 0003_open_tasks_by_assignee_preset_accounts.sql
-- Core migration 000066 moved a person's or agent's display name off `users`
-- and `agents` onto `accounts`, and replaced project_members.user_id/agent_id
-- with project_members.account_id. The "Open tasks by assignee" preset read
-- the old columns, so every panel created from it would now fail.
--
-- Panels copy the preset's SQL when they are created, so rewrite the ones that
-- still hold the preset text unchanged (compared ignoring whitespace). A panel
-- the user has edited is left alone: it is theirs to adapt, and the plugin
-- shows the query error when it fails.
-- Run with search_path = plugin_data_com_paca_dashboard, public.

UPDATE dashboard_panels
SET query = $new$SELECT COALESCE(ac.name, 'Unassigned') AS assignee, COUNT(DISTINCT t.id) AS open_tasks
FROM tasks t
JOIN task_statuses ts ON ts.id = t.status_id
LEFT JOIN task_assignees ta ON ta.task_id = t.id
LEFT JOIN project_members pm ON pm.id = ta.member_id
LEFT JOIN accounts ac ON ac.id = pm.account_id
WHERE t.project_id = {{project_id}} AND ts.category != 'done' AND t.deleted_at IS NULL
GROUP BY pm.account_id, ac.name
ORDER BY open_tasks DESC$new$,
    updated_at = NOW()
WHERE type IN ('chart', 'table')
  AND regexp_replace(query, '\s+', ' ', 'g') = $old$SELECT COALESCE(NULLIF(u.full_name, ''), u.username, a.name, 'Unassigned') AS assignee, COUNT(DISTINCT t.id) AS open_tasks FROM tasks t JOIN task_statuses ts ON ts.id = t.status_id LEFT JOIN task_assignees ta ON ta.task_id = t.id LEFT JOIN project_members pm ON pm.id = ta.member_id LEFT JOIN users u ON u.id = pm.user_id LEFT JOIN agents a ON a.id = pm.agent_id WHERE t.project_id = {{project_id}} AND ts.category != 'done' AND t.deleted_at IS NULL GROUP BY pm.id, u.full_name, u.username, a.name ORDER BY open_tasks DESC$old$;
