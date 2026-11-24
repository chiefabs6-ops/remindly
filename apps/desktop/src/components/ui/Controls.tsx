// Tabs, segmented control and switch from mockup E.
import type { ReactNode } from "react";

export interface TabItem<K extends string> { key: K; label: string; count?: number; negative?: boolean }

export function Tabs<K extends string>({ items, value, onChange, label }: {
  items: TabItem<K>[]; value: K; onChange: (k: K) => void; label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((t) => (
        <button key={t.key} type="button" role="tab" className="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className={`n num ${t.negative && t.count > 0 ? "neg" : ""}`}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<V extends string | number>({ options, value, onChange, label }: {
  options: { value: V; label: ReactNode }[]; value: V; onChange: (v: V) => void; label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className="toggle" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)} />
  );
}
