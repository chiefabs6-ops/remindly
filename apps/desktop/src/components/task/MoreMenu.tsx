import { useNavigate } from "react-router";
import { AppWindow, Copy, Ellipsis, Maximize2, Trash2 } from "lucide-react";
import type { TaskDetail } from "@tether/core";
import { api, errorMessage } from "../../lib/api";
import { Popover, usePopover } from "../ui/Popover";
import type { TaskEdit } from "./useTaskEdit";

/** "More" menu: open full page (quick panel only), new window, duplicate, delete. */
export function MoreMenu({ t, ed, onDeleted, showOpen }: { t: TaskDetail; ed: TaskEdit; onDeleted: () => void; showOpen?: boolean }) {
  const navigate = useNavigate();
  const pop = usePopover();
  const icon = { size: 15, strokeWidth: 1.6 };
  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="More actions" title="More" aria-haspopup="menu"
        aria-expanded={!!pop.anchor} onClick={(e) => pop.open(e.currentTarget)}><Ellipsis size={16} /></button>
      <Popover anchor={pop.anchor} onClose={pop.close} label="More actions" role="menu">
        {showOpen && <button type="button" role="menuitem" className="pop-item" onClick={() => { pop.close(); navigate(`/task/${t.id}`); }}><Maximize2 {...icon} />Open full page</button>}
        <button type="button" role="menuitem" className="pop-item" onClick={() => { pop.close(); api.openTaskWindow(t.id).catch((e) => alert(errorMessage(e))); }}><AppWindow {...icon} />Open in new window</button>
        <button type="button" role="menuitem" className="pop-item" onClick={() => { pop.close(); ed.duplicate.mutate(undefined, { onSuccess: (c) => navigate(`/task/${c.id}`) }); }}><Copy {...icon} />Duplicate</button>
        <hr className="pop-sep" />
        <button type="button" role="menuitem" className="pop-item danger" onClick={() => {
          pop.close();
          if (confirm(`Delete "${t.title}"${t.subtaskCount ? ` and its ${t.subtaskCount} subtasks` : ""}?`)) ed.remove.mutate(undefined, { onSuccess: onDeleted });
        }}><Trash2 {...icon} />Delete</button>
      </Popover>
    </>
  );
}
