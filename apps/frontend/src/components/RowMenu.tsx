import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

// The quiet row kebab. Handoffs are automatic, so this is the manual layer the model
// can't decide: is this a client, a personal contact, or not a real account (delete).
// Delete asks for a second click inline — no native confirm dialog.
export function RowMenu({ onMarkClient, onMarkPersonal, onDelete, isPersonal = false }: { onMarkClient: () => void; onMarkPersonal: (on: boolean) => void; onDelete: () => void; isPersonal?: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) { setConfirming(false); return; }
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  // The search popup's look: hairline border, 13px rows, the soft hover band.
  const item = "flex w-full items-center rounded-lg px-2 py-1.5 text-left text-[13px] text-foreground transition-colors duration-fast hover:bg-hover";
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button onClick={() => setOpen((o) => !o)} aria-label="Account actions"
        className={`flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground ${open ? "bg-muted/60 text-foreground" : "opacity-0 group-hover:opacity-100"}`}>
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-xl border border-border/70 bg-popover p-1 shadow-pop">
          <button className={item} onClick={() => { setOpen(false); onMarkClient(); }}>Mark as client</button>
          {/* Network is reversible (GET-1018): one already in it can be taken back out. */}
          <button className={item} onClick={() => { setOpen(false); onMarkPersonal(!isPersonal); }}>{isPersonal ? "Remove from network" : "Mark as network"}</button>
          <div className="-mx-1 my-1 h-px bg-hairline" />
          {confirming ? (
            <button className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-risk transition-colors duration-fast hover:bg-risk/10"
              onClick={() => { setOpen(false); onDelete(); }}>Click to confirm delete</button>
          ) : (
            <button className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-[13px] text-risk transition-colors duration-fast hover:bg-risk/10"
              onClick={() => setConfirming(true)}>Delete</button>
          )}
        </div>
      )}
    </div>
  );
}
