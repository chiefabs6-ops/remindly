import { QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Navigate, Route, Routes, useSearchParams } from "react-router";
import { Layout, useTheme } from "./components/Layout";
import { queryClient, useSettings } from "./lib/queries";
import { NotesScreen } from "./screens/Notes";
import { ProjectsScreen } from "./screens/Projects";
import { ReviewScreen } from "./screens/Review";
import { SettingsScreen } from "./screens/Settings";
import { TasksScreen } from "./screens/Tasks";
import { TaskPage } from "./screens/TaskPage";
import { TodayScreen } from "./screens/Today";
import { WelcomeScreen } from "./screens/Welcome";

/** Approvals live on Today now; old links (notifications, Chrome) still work. */
function InboxRedirect() {
  const [p] = useSearchParams();
  const s = p.get("s");
  return <Navigate to={s ? `/?s=${encodeURIComponent(s)}` : "/?approvals=1"} replace />;
}

function Shell() {
  useTheme();
  const settings = useSettings();
  if (settings.isLoading) return null;
  if (settings.data && settings.data.onboarded !== true) return <WelcomeScreen />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<TodayScreen />} />
        <Route path="inbox" element={<InboxRedirect />} />
        <Route path="tasks" element={<TasksScreen />} />
        <Route path="task/:id" element={<TaskPage />} />
        <Route path="projects" element={<ProjectsScreen />} />
        <Route path="projects/:projectId" element={<TasksScreen />} />
        <Route path="notes" element={<NotesScreen />} />
        <Route path="review" element={<ReviewScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        <Route path="*" element={<TodayScreen />} />
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
