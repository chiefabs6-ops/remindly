// Loading placeholders. Shown while a screen's data is on its way, so the empty state never flashes.
import type { CSSProperties } from "react";

/** A few list rows (check, title, meta). */
export function SkeletonRows({ n = 5, label = "Loading" }: { n?: number; label?: string }) {
  return (
    <div className="skel-rows" role="group" aria-busy="true" aria-label={label}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skel-row">
          <span className="skel skel-dot" />
          <span className="skel skel-line" style={{ width: `${70 - ((i * 13) % 35)}%` }} />
          <span className="skel skel-meta" />
        </div>
      ))}
    </div>
  );
}

/** One block, for a card or a panel. Size it with `height` / `style`. */
export function SkeletonBlock({ height = 120, label = "Loading", style }: { height?: number; label?: string; style?: CSSProperties }) {
  return <div className="skel skel-block" role="group" aria-busy="true" aria-label={label} style={{ height, ...style }} />;
}

/** A page title and a few lines of text. */
export function SkeletonPage({ lines = 4, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div className="skel-page" role="group" aria-busy="true" aria-label={label}>
      <span className="skel skel-title" />
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skel skel-line" style={{ width: `${95 - i * 15}%` }} />
      ))}
    </div>
  );
}
