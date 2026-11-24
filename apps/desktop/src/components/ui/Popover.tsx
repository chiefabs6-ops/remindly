// A floating panel anchored to a button. Flips above when there is no room below and
// closes on outside click, Escape or window resize. The only things that cast a shadow.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Popover({ anchor, onClose, children, label, role = "dialog" }: {
  anchor: HTMLElement | null; onClose: () => void; children: ReactNode; label: string; role?: "dialog" | "menu";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const r = anchor.getBoundingClientRect();
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    ref.current?.querySelector<HTMLElement>("button:not([disabled]), [href], input")?.focus({ preventScroll: true });
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor.focus();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  if (!anchor) return null;
  return createPortal(
    <div ref={ref} className="pop" role={role} aria-label={label}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}>
      {children}
    </div>,
    document.body,
  );
}

/** Which element (if any) a popover is open on. Clicking the same anchor again closes it. */
export function usePopover() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return {
    anchor,
    open: (el: HTMLElement) => setAnchor((cur) => (cur === el ? null : el)),
    close: () => setAnchor(null),
  };
}
