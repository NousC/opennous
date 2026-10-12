// Drag-to-resize for a right-hand dock.
//
// Shared by the document dock and the source viewer, so a transcript resizes exactly like a
// report — same grab edge, same bounds, same feel. Two copies of this would drift the moment
// one of them changed its minimum, and "why does the transcript stop at 700 but the report
// goes to 760" is a bug nobody can see the cause of.
//
// NOT persisted, deliberately: a width is a per-sitting choice, and restoring a 900px dock
// onto a laptop screen would be its own bug.

import { useEffect, useRef, useState } from "react";

export function useDockWidth(initial = 480) {
  const [width, setWidth] = useState(initial);
  const dragging = useRef(false);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      // Bounded on both sides: narrow enough to be useless, or wide enough to squeeze the
      // conversation out, are both ways of losing the thing you opened it next to.
      setWidth(Math.min(Math.max(window.innerWidth - e.clientX, 360), Math.min(760, window.innerWidth - 420)));
    };
    const up = () => { dragging.current = false; document.body.style.cursor = ""; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  const startDrag = () => { dragging.current = true; document.body.style.cursor = "col-resize"; };

  /** The grab edge. Thin, invisible until you are on it. */
  const gripProps = {
    onMouseDown: startDrag,
    className: "print-hide absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-foreground/10",
  };

  return { width, gripProps };
}
