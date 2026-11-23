import { QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Route, Routes } from "react-router";
import { Layout, useTheme } from "./components/Layout";
import { queryClient, useSettings } from "./lib/queries";
import { InboxScreen } from "./screens/Inbox";
import { NotesScreen } from "./screens/Notes";
import { ProjectsScreen } from "./screens/Projects";
import { ReviewScreen } from "./screens/Review";
import { SettingsScreen } from "./screens/Settings";
import { TasksScreen } from "./screens/Tasks";
import { TodayScreen } from "./screens/Today";
import { WelcomeScreen } from "./screens/Welcome";

function Shell() {
  useTheme();
  const settings = useSettings();
  if (settings.isLoading) return null;
  if (settings.data && settings.data.onboarded !== true) return <WelcomeScreen />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<TodayScreen />} />
        <Route path="inbox" element={<InboxScreen />} />
        <Route path="tasks" element={<TasksScreen />} />
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
