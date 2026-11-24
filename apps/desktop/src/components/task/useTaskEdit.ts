// Every save the quick panel and the full page can make, built on the newest copy of the task.
import { addDays, type Priority, type TaskDetail, type TaskInput, type TaskStatus } from "@tether/core";
import { api } from "../../lib/api";
import { todayIso } from "../../lib/format";
import { keys, queryClient, useAction } from "../../lib/queries";
import { useToast } from "../ui/Toast";
import { completeTask, patchTask, rescheduleTask } from "../../lib/taskActions";

export function useTaskEdit(t: TaskDetail) {
  const toast = useToast();
  // Build each save from the newest copy of the task, so overlapping edits never send stale fields back.
  const latest = () => queryClient.getQueryData<TaskDetail>(keys.task(t.id)) ?? t;
  // Each save reads the task fresh first, so an edit made in another window is never sent back stale.
  const patch = useAction((p: Partial<TaskInput>) => patchTask(t.id, p));
  const setStatus = useAction((s: TaskStatus) => api.setStatus(t.id, s, s === "completed"));
  // Moving the date keeps the saved time; a cleared time stays cleared.
  const resched = useAction((date: string | null) => rescheduleTask(t.id, date));
  const remind = useAction((iso: string) => api.remindAt(t.id, iso));
  const duplicate = useAction(() => api.duplicate(t.id));
  const remove = useAction(() => api.deleteTask(t.id));

  const done = t.status === "completed";
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.all });
  const toggle = useAction(async () => {
    const was = latest();
    if (was.status === "completed") {
      await api.setStatus(t.id, "not_started", false);
      return;
    }
    // Undo puts back the old status and reopens exactly the subtasks this completed.
    const undo = await completeTask(t.id);
    toast(`Completed “${was.title}”`, () => undo().then(refresh));
  });

  const reschedule = (date: string | null) => {
    resched.mutate(date, {
      onSuccess: (undo) => toast(date ? "Rescheduled" : "Date removed", () => undo().then(refresh)),
    });
  };
  const saveTags = (text: string) => {
    const tags = [...new Set(text.split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean))];
    if (tags.join(",") !== latest().tags.join(",")) patch.mutate({ tags });
  };
  const today = todayIso();
  const busy = patch.isPending || setStatus.isPending || resched.isPending || toggle.isPending;
  const error = toggle.error ?? duplicate.error ?? remove.error ?? patch.error ?? setStatus.error ?? resched.error ?? remind.error;
  return {
    done, busy, error, latest, patch, setStatus, toggle, reschedule, remind, duplicate, remove, saveTags,
    setPriority: (p: Priority) => patch.mutate({ priority: p }),
    tomorrow: () => reschedule(addDays(today, 1)),
    nextWeek: () => reschedule(addDays(today, 7)),
  };
}
export type TaskEdit = ReturnType<typeof useTaskEdit>;
