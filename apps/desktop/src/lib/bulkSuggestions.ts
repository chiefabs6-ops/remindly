// Approve all / Dismiss all for a list of suggestions. Used by the My Tasks tray and the Inbox.
import { useRef, useState } from "react";
import type { SuggestedTask, Suggestion } from "@tether/core";
import { api, errorMessage } from "./api";
import { useInvalidateAll } from "./queries";
import { useToast } from "../components/ui/Toast";

/** "Approve all" adds these with one call and no edits. Duplicates and changes to existing tasks need a human look. */
export function canBulkApprove(s: Suggestion): boolean {
  if (s.possibleDuplicateOf) return false;
  if (s.kind === "note") return true;
  return s.kind === "task" && !!(s.payload as SuggestedTask).title?.trim();
}

/** The toast text after Approve all. */
export function approveSummary(approved: number, dupes: number, others: number): string {
  const left = dupes + others;
  const head = `Approved ${approved}.`;
  if (left === 0) return head;
  const why = others === 0 ? ` (${dupes === 1 ? "looks like a duplicate" : "look like duplicates"})` : "";
  return `${head} ${left} left for you to check${why}.`;
}

export function useBulkSuggestions() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [running, setRunning] = useState(false);
  const lock = useRef(false);

  /** One call at a time. On the first error: stop, tell the user, keep the rest pending. */
  const loop = async (list: Suggestion[], call: (s: Suggestion) => Promise<unknown>) => {
    let done = 0;
    let error: unknown = null;
    for (const s of list) {
      try {
        await call(s);
        done++;
      } catch (e) {
        error = e;
        break;
      }
    }
    return { done, error };
  };

  const wrap = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setRunning(true);
    try {
      await fn();
    } finally {
      lock.current = false;
      setRunning(false);
      await invalidate();
    }
  };

  const approveAll = (list: Suggestion[]) =>
    wrap(async () => {
      const todo = list.filter(canBulkApprove);
      const skipped = list.filter((s) => !canBulkApprove(s));
      const dupes = skipped.filter((s) => s.possibleDuplicateOf).length;
      const { done, error } = await loop(todo, (s) => api.approveSuggestion(s.id));
      if (error) {
        toast(`${done > 0 ? `Approved ${done}, then stopped. ` : ""}${errorMessage(error)}`);
        return;
      }
      toast(approveSummary(done, dupes, skipped.length - dupes));
    });

  const dismissAll = (list: Suggestion[]) =>
    wrap(async () => {
      const { done, error } = await loop(list, (s) => api.dismissSuggestion(s.id));
      if (error) {
        toast(`${done > 0 ? `Dismissed ${done}, then stopped. ` : ""}${errorMessage(error)}`);
        return;
      }
      toast(`Dismissed ${done}.`);
    });

  return { running, approveAll, dismissAll };
}
