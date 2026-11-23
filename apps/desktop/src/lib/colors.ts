// Project colours (from mockup C): each project is a pale tile in its own hue, with the dark of that
// hue as ink. Projects store the ink hex; older saved colours map to the nearest tone.

export type Tone = "blue" | "green" | "amber" | "teal" | "rose" | "slate" | "stone";

export const TONES: { tone: Tone; ink: string; label: string }[] = [
  { tone: "blue", ink: "#0a3a80", label: "Blue" },
  { tone: "amber", ink: "#7a3d00", label: "Amber" },
  { tone: "green", ink: "#1f5a36", label: "Green" },
  { tone: "teal", ink: "#0f5450", label: "Teal" },
  { tone: "rose", ink: "#8a1c3c", label: "Rose" },
  { tone: "slate", ink: "#2d3a4a", label: "Slate" },
  { tone: "stone", ink: "#55462f", label: "Stone" },
];

/** Colours saved by earlier versions → their tone. */
const LEGACY: Record<string, Tone> = {
  "#1d5fbf": "blue",
  "#2e7d32": "green",
  "#b45309": "amber",
  "#0f766e": "teal",
  "#be123c": "rose",
  "#4d4d4d": "slate",
  "#8a8a8a": "stone",
};

export function toneOf(color: string | null | undefined): Tone {
  const c = (color ?? "").toLowerCase();
  return TONES.find((t) => t.ink === c)?.tone ?? LEGACY[c] ?? "slate";
}

/** Style for a pale tile or chip in the project's tone (light/dark handled by CSS variables). */
export function toneStyle(color: string | null | undefined): React.CSSProperties {
  const t = toneOf(color);
  return { background: `var(--tone-${t}-bg)`, color: `var(--tone-${t}-ink)` };
}

/** Solid dot colour for the sidebar. */
export function toneDot(color: string | null | undefined): string {
  return `var(--tone-${toneOf(color)}-ink)`;
}
