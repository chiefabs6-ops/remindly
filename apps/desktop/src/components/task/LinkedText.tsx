// Plain text with its web addresses turned into links that open in the system browser.
// Only http(s) addresses are linked; everything else stays text (no HTML is ever parsed).
import { Fragment } from "react";
import { openExternal } from "./model";

const URL_RE = /(https?:\/\/[^\s<>"'`]+)/gi;
/** Punctuation that usually ends a sentence rather than the address ("see https://x.com/a."). */
const TRAILING = /[.,;:!?)\]}]+$/;

export interface TextPart { text: string; url?: string }

/** Split text into plain parts and http(s) links. Trailing punctuation stays outside the link. */
export function splitLinks(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let url = m[0];
    const tail = TRAILING.exec(url)?.[0] ?? "";
    if (tail) url = url.slice(0, -tail.length);
    if (start > last) out.push({ text: text.slice(last, start) });
    if (url.length > "https://".length) out.push({ text: url, url });
    else out.push({ text: url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((p, i) =>
        p.url ? (
          <a key={i} className="tlink" href={p.url} title={p.url}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openExternal(p.url!); }}
            onAuxClick={(e) => e.preventDefault()}>{p.text}</a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}
