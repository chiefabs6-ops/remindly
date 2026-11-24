// Every save the quick panel and the full page can make, built on the newest copy of the task.
import { addDays, type Priority, type TaskDetail, type TaskInput, type TaskStatus } from "@tether/core";
import { api } from "../../lib/api";
import { todayIso } from "../../lib/format";
import { keys, queryClient, useAction } from "../../lib/queries";
import { useToast } from "../ui/Toast";
import { asInput } from "./model";

export function useTaskEdit(t: TaskDetail) {
  const toast = useToast();
  // Build each save from the newest copy of the task, so overlapping edits never send stale fields back.
  const latest = () => queryClient.getQueryData<TaskDetail>(keys.task(t.id)) ?? t;
  const patch = useAction((p: Partial<TaskInput>) => api.updateTask(t.id, { ...asInput(latest()), ...p }));
  const setStatus = useAction((s: TaskStatus) => api.setStatus(t.id, s, s === "completed"));
  // Moving the date keeps the saved time; a cleared time stays cleared.
  const resched = useAction((a: { date: string | null; time: string | null }) => api.reschedule(t.id, a.date, a.time));
  const remind = useAction((iso: string) => api.remindAt(t.id, iso));
  const duplicate = useAction(() => api.duplicate(t.id));
  const remove = useAction(() => api.deleteTask(t.id));

  const done = t.status === "completed";
  const toggle = useAction(async () => {
    const was = latest();
    const nowDone = was.status === "completed";
    await api.setStatus(t.id, nowDone ? "not_started" : "completed", !nowDone);
    if (!nowDone) toast(`Completed “${was.title}”`, () => api.setStatus(t.id, "not_started", false).then(() => queryClient.invalidateQueries({ queryKey: keys.all })));
  });

  const reschedule = (date: string | null) => {
    const old = latest();
    resched.mutate({ date, time: date ? old.dueTime : null }, {
      onSuccess: () => toast(date ? "Rescheduled" : "Date removed", () =>
        api.reschedule(t.id, old.dueDate, old.dueTime).then(() => queryClient.invalidateQueries({ queryKey: keys.all }))),
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
