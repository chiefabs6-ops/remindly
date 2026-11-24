import { useEffect, useRef, useState } from "react";

/** An input that saves once, on blur or Enter (not on every keystroke), and follows the saved value while idle. */
/** onSettle runs after every blur/Enter with the final text, changed or not (e.g. to fold an empty field back into a button). */
export function CommitInput({ value, onCommit, onSettle, ...rest }: { value: string; onCommit: (v: string) => void; onSettle?: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const commit = () => {
    editing.current = false;
    if (draft !== value) onCommit(draft);
    onSettle?.(draft);
  };
  return (
    <input {...rest} value={draft}
      onFocus={() => { editing.current = true; }}
      onChange={(e) => { editing.current = true; setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />
  );
}
