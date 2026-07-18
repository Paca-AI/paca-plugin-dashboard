import DashboardPage from "./DashboardPage";

interface ProjectDashboardPageProps {
  projectId: string;
}

/**
 * ProjectDashboardPage — the `project.page` entry component exposed by the
 * dashboard plugin, reached via a dedicated project sidebar nav item. Thin
 * wrapper: the actual chart/stat-card UI lives in the shared DashboardPage
 * component, also used by AdminDashboardPage.
 */
export default function ProjectDashboardPage({
  projectId,
}: ProjectDashboardPageProps) {
  return <DashboardPage scope={{ kind: "project", projectId }} />;
}
