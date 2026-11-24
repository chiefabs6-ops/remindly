// One toast at a time, bottom centre, with an optional Undo. Lives for 5 s.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Undo = () => void | Promise<unknown>;
type Show = (message: string, undo?: Undo) => void;
const Ctx = createContext<Show>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string; undo?: Undo } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback<Show>((message, undo) => {
    clearTimeout(timer.current);
    setToast({ id: Date.now(), message, undo });
    timer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div role="status" aria-live="polite">
        {toast && (
          <div className="toast" key={toast.id}>
            <span>{toast.message}</span>
            {toast.undo && (
              <button type="button" onClick={() => { const u = toast.undo!; setToast(null); void u(); }}>Undo</button>
            )}
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
