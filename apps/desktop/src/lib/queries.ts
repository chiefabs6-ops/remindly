import { useEffect } from "react";
import { focusManager, QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NoteFilter, SuggestionStatus, TaskFilter } from "@tether/core";
import { api, onDataChanged } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    // Local data: no network flakiness, so no retries; refetch on focus keeps "today" current.
    queries: { retry: false, staleTime: 5_000, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

// Refetch when this window gains focus, not only when it becomes visible: with a pop-out task window
// open, both windows stay visible and each has its own cache.
focusManager.setEventListener((handleFocus) => {
  const onFocus = () => handleFocus(true);
  const onVisible = () => handleFocus(document.visibilityState === "visible");
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisible);
  };
});

export const keys = {
  all: ["tether"] as const,
  dashboard: ["tether", "dashboard"] as const,
  tasks: (f: TaskFilter) => ["tether", "tasks", f] as const,
  task: (id: string) => ["tether", "task", id] as const,
  projects: (archived: boolean) => ["tether", "projects", archived] as const,
  notes: (f: NoteFilter) => ["tether", "notes", f] as const,
  suggestions: (s: SuggestionStatus | null) => ["tether", "suggestions", s] as const,
  settings: ["tether", "settings"] as const,
  meeting: (noteId: string) => ["tether", "meeting", noteId] as const,
  search: (q: string) => ["tether", "search", q] as const,
};

/** Every write can change counts anywhere (dashboard, sidebar), so refresh everything. Cheap locally. */
export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: keys.all });
}

/** Refresh when the backend reports a change made outside the UI (Chrome, Claude Code). */
export function useBackendSync() {
  const invalidate = useInvalidateAll();
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    onDataChanged(invalidate).then((u) => (cancelled ? u() : (stop = u)));
    return () => {
      cancelled = true;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export const useDashboard = () => useQuery({ queryKey: keys.dashboard, queryFn: api.dashboard });
export const useTasks = (f: TaskFilter) => useQuery({ queryKey: keys.tasks(f), queryFn: () => api.tasks(f) });
export const useTask = (id: string | null) =>
  useQuery({ queryKey: keys.task(id ?? ""), queryFn: () => api.task(id!), enabled: !!id });
export const useProjects = (archived = false) =>
  useQuery({ queryKey: keys.projects(archived), queryFn: () => api.projects(archived) });
export const useNotes = (f: NoteFilter) => useQuery({ queryKey: keys.notes(f), queryFn: () => api.notes(f) });
export const useSuggestions = (s: SuggestionStatus | null) =>
  useQuery({ queryKey: keys.suggestions(s), queryFn: () => api.suggestions(s) });
/** Meeting record behind a note (null for ordinary notes). Polls while the summary is being made. */
export const useMeetingForNote = (noteId: string | null) =>
  useQuery({
    queryKey: keys.meeting(noteId ?? ""),
    queryFn: () => api.meetingForNote(noteId!),
    enabled: !!noteId,
    refetchInterval: (q) => {
      const s = q.state.data?.summaryStatus;
      return s === "pending" || s === "running" ? 5_000 : false;
    },
  });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: api.settings });
/** True when the user switched local AI on (buttons stay hidden otherwise). */
export function useAiEnabled() {
  const q = useQuery({ queryKey: ["tether", "ai-settings"], queryFn: api.aiSettings });
  return !!q.data?.enabled;
}
export const useSearch = (q: string) =>
  useQuery({ queryKey: keys.search(q), queryFn: () => api.search(q), enabled: q.trim().length > 0 });

/** A mutation that refreshes all data when it succeeds. */
export function useAction<A, R>(fn: (a: A) => Promise<R>) {
  const invalidate = useInvalidateAll();
  return useMutation({ mutationFn: fn, onSuccess: () => invalidate() });
}
