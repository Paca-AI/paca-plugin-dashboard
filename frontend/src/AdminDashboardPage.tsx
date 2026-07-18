import DashboardPage from "./DashboardPage";

/**
 * AdminDashboardPage — the `admin.page` entry component exposed by the
 * dashboard plugin, reached via a dedicated nav item in the admin sidebar;
 * gated by the built-in `users.write` global permission (see plugin.json),
 * matching the host's other admin pages. Thin wrapper: the actual
 * cross-project table UI lives in the shared DashboardPage component, also
 * used by ProjectDashboardPage.
 */
export default function AdminDashboardPage() {
  return <DashboardPage scope={{ kind: "admin" }} />;
}
