import { useState } from "react";
import { Link2, Plus, X } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { api, errorMessage } from "../../lib/api";
import { hostOf } from "../../lib/format";
import { useAction } from "../../lib/queries";
import { openExternal } from "./model";

function Row({ url, title, onRemove }: { url: string; title: string | null; onRemove?: () => void }) {
  const host = hostOf(url) ?? url;
  return (
    <li className="lk">
      <a href={url} title={url} onClick={(e) => { e.preventDefault(); void openExternal(url); }} onAuxClick={(e) => e.preventDefault()}>
        <Link2 size={14} strokeWidth={1.6} /><span>{title || host}</span>{title && <small>{host}</small>}
      </a>
      {onRemove && <button type="button" className="rm" aria-label={`Remove link ${title || host}`} onClick={onRemove}><X size={13} /></button>}
    </li>
  );
}

/** Web links on a task (files come later). The Chrome source page is listed first and cannot be removed here. */
export function Links({ t }: { t: TaskDetail }) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const add = useAction(() => api.addLink(t.id, url.trim(), title.trim() || null));
  const remove = useAction((id: string) => api.removeLink(id));
  const count = t.links.length + (t.sourceUrl ? 1 : 0);
  const cancel = () => { setAdding(false); setUrl(""); setTitle(""); add.reset(); };
  return (
    <section className="sec" aria-labelledby="links-h">
      <div className="sec-h">
        <span id="links-h">Links</span>{count > 0 && <span className="c num">{count}</span>}
        <button type="button" className="a" onClick={() => (adding ? cancel() : setAdding(true))}><Plus size={13} />Add link</button>
      </div>
      {count > 0 && (
        <ul className="links">
          {t.sourceUrl && <Row url={t.sourceUrl} title={t.sourceTitle} />}
          {t.links.map((l) => <Row key={l.id} url={l.url} title={l.title} onRemove={() => remove.mutate(l.id)} />)}
        </ul>
      )}
      {count === 0 && !adding && <p className="td-empty">No links yet.</p>}
      {adding && (
        <form className="linkform" onSubmit={(e) => { e.preventDefault(); if (url.trim()) add.mutate(undefined, { onSuccess: cancel }); }}>
          <label className="sr-only" htmlFor="link-url">Link address</label>
          <input id="link-url" className="field" placeholder="https://…" value={url} autoFocus onChange={(e) => { setUrl(e.target.value); add.reset(); }} />
          <label className="sr-only" htmlFor="link-title">Link title (optional)</label>
          <input id="link-title" className="field" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button type="submit" className="btn" disabled={!url.trim() || add.isPending}>Save link</button>
          <button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button>
        </form>
      )}
      {add.isError && <p className="td-err" role="alert">{errorMessage(add.error)}</p>}
      {remove.isError && <p className="td-err">{errorMessage(remove.error)}</p>}
    </section>
  );
}
