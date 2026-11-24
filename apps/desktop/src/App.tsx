import { QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Navigate, Route, Routes, useSearchParams } from "react-router";
import { Layout, useTheme } from "./components/Layout";
import { queryClient, useSettings } from "./lib/queries";
import { InboxScreen } from "./screens/Inbox";
import { NotesScreen } from "./screens/Notes";
import { OverviewScreen } from "./screens/Overview";
import { ProjectsScreen } from "./screens/Projects";
import { ReviewScreen } from "./screens/Review";
import { SettingsScreen } from "./screens/Settings";
import { TasksScreen } from "./screens/Tasks";
import { TaskPage } from "./screens/TaskPage";
import { WelcomeScreen } from "./screens/Welcome";

/** Old links to "/" (notification buttons, Chrome): approvals and suggestions now live on the Inbox page. */
function HomeRoute() {
  const [p] = useSearchParams();
  const s = p.get("s");
  if (s) return <Navigate to={`/inbox?s=${encodeURIComponent(s)}`} replace />;
  const task = p.get("task");
  if (task) return <Navigate to={`/task/${encodeURIComponent(task)}`} replace />;
  if (p.get("approvals") === "1") return <Navigate to="/inbox" replace />;
  return <OverviewScreen />;
}

function Shell() {
  useTheme();
  const settings = useSettings();
  if (settings.isLoading) return null;
  if (settings.data && settings.data.onboarded !== true) return <WelcomeScreen />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomeRoute />} />
        <Route path="inbox" element={<InboxScreen />} />
        <Route path="tasks" element={<TasksScreen />} />
        <Route path="task/:id" element={<TaskPage />} />
        <Route path="projects" element={<ProjectsScreen />} />
        <Route path="projects/:projectId" element={<TasksScreen />} />
        <Route path="notes" element={<NotesScreen />} />
        <Route path="review" element={<ReviewScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        <Route path="*" element={<HomeRoute />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Hash routing: the Tauri asset protocol serves one index.html. */}
      <HashRouter>
        <Shell />
      </HashRouter>
    </QueryClientProvider>
  );
}
