import { useState } from "react";
import type { TaskDetail } from "@tether/core";
import { api, errorMessage } from "../../lib/api";
import { ago } from "../../lib/format";
import { useAction } from "../../lib/queries";
import { historyLine } from "./model";

const SHOWN = 15;

/** History lines (newest first; written updates in full ink) and a box to add an update. */
export function Activity({ t }: { t: TaskDetail }) {
  const [text, setText] = useState("");
  const [all, setAll] = useState(false);
  const add = useAction(() => api.addComment(t.id, text.trim()));
  const lines = all ? t.history : t.history.slice(0, SHOWN);
  return (
    <section className="sec" aria-labelledby="activity-h">
      <div className="sec-h"><span id="activity-h">Activity</span></div>
      <ul className="hist">
        {lines.map((h) => (
          <li key={h.id} className={h.action === "comment" ? "cm" : undefined}>
            <time dateTime={h.at}>{ago(h.at)}</time><span>{historyLine(h)}</span>
          </li>
        ))}
        {t.history.length === 0 && <li><time>{ago(t.createdAt)}</time><span>Created</span></li>}
      </ul>
      {!all && t.history.length > SHOWN && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAll(true)}>Show all {t.history.length}</button>}
      <form className="comment" onSubmit={(e) => { e.preventDefault(); if (text.trim()) add.mutate(undefined, { onSuccess: () => setText("") }); }}>
        <label htmlFor="cmt" className="sr-only">Add an update</label>
        <input id="cmt" className="field" maxLength={2000} placeholder="Add an update — e.g. “waiting on Sinéad”" value={text} onChange={(e) => { setText(e.target.value); add.reset(); }} />
        <button type="submit" className="btn" disabled={!text.trim() || add.isPending}>Add</button>
      </form>
      {add.isError && <p className="td-err" role="alert">{errorMessage(add.error)}</p>}
    </section>
  );
}
