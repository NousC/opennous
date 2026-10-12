// Persisted, draggable column widths for the custom flex tables (Companies /
// People). The widths live in localStorage under `key` so a user's layout
// survives reloads. Only fixed-width columns participate; an elastic flex-1
// column (e.g. "Top Contacts") absorbs whatever slack is left over.
import { useCallback, useRef, useState } from "react";

const MIN_COL = 40;

export function useColumnWidths(key: string, defaults: Record<string, number>) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "{}");
      return { ...defaults, ...saved };
    } catch {
      return { ...defaults };
    }
  });

  // Keep a live ref so the document-level drag listeners read fresh widths
  // without re-binding on every mousemove.
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const startResize = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthsRef.current[col] ?? defaults[col] ?? 80;
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_COL, Math.round(startW + (ev.clientX - startX)));
      setWidths(prev => ({ ...prev, [col]: w }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem(key, JSON.stringify(widthsRef.current)); } catch { /* ignore */ }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [key, defaults]);

  const reset = useCallback(() => {
    setWidths({ ...defaults });
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }, [key, defaults]);

  return { widths, startResize, reset };
}

// The drag affordance — a thin strip on the right edge of a header cell. The
// parent header cell must be `position: relative` for it to anchor correctly.
export function ColResizer({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <span
      onMouseDown={onMouseDown}
      onClick={e => e.stopPropagation()}
      className="group/resize absolute top-0 right-0 z-10 flex h-full w-2 cursor-col-resize items-center justify-center"
    >
      <span className="h-3.5 w-px bg-border transition-colors group-hover/resize:bg-foreground/40" />
    </span>
  );
}
