// Quick view of one task beside the My Tasks list (mockup E). Built in step 3; this is the agreed contract.
// Step 2 renders it; step 3 owns its insides.

export interface QuickPanelProps {
  /** Task to show. */
  id: string;
  /** Close the panel (Esc, close button, scrim click). */
  onClose: () => void;
}

export function QuickPanel({ id, onClose }: QuickPanelProps) {
  return (
    <aside aria-label="Task details" data-task={id} className="p-5">
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
    </aside>
  );
}
