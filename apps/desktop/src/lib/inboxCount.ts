import type { Suggestion } from "@tether/core";
import { useDashboard, useSuggestions } from "./queries";

/** A Claude task suggestion waits in the My Tasks tray, not in the Inbox. */
export const isClaudeTask = (s: Pick<Suggestion, "origin" | "kind">) => s.origin === "claude" && s.kind === "task";

/**
 * What the Inbox page holds: pending suggestions that are not Claude task suggestions
 * (Chrome captures, changes, notes) plus tasks still in the "inbox" status (unsorted quick adds).
 */
export function useInboxCounts() {
  const sugg = useSuggestions("pending");
  const dash = useDashboard();
  const pending = sugg.data ?? [];
  const captures = pending.filter((s) => !isClaudeTask(s)).length;
  const unsorted = dash.data?.inboxCount ?? 0;
  const claude = pending.filter(isClaudeTask);
  return { captures, unsorted, total: captures + unsorted, claude };
}
