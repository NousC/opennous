// The app-wide shortcuts (GET-601): G-then-letter to move between pages, C for a new task from
// anywhere, ? for the sheet that lists them all. Mounted once in the app shell.
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { GO_TO, SHORTCUTS, useHotkey } from "@/lib/hotkeys";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { cloud } from "@/lib/cloud";

function GoTo({ combo, to }: { combo: string; to: string }) {
  const navigate = useNavigate();
  useHotkey(combo, () => navigate(to));
  return null;
}

export function AppShortcuts() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  useHotkey("?", () => setOpen(true));
  // New task from anywhere: the Tasks page opens its form on ?new=1. From an account (or one of its
  // deals) the form opens with that account picked (GET-607).
  const accountId = /^\/accounts\/([^/]+)/.exec(pathname)?.[1];
  // Not on a page where typing is the point (a job chat, cloud.shell.typingPage): a stray "c" before
  // the input has focus jumped to the Inbox's New task (GET-868).
  useHotkey("c", () => { if (cloud.shell?.typingPage?.(pathname)) return; navigate(accountId ? `/tasks?new=1&account=${encodeURIComponent(accountId)}` : "/tasks?new=1"); });
  return (
    <>
      {Object.entries(GO_TO).map(([combo, to]) => <GoTo key={combo} combo={combo} to={to} />)}
      <Dialog open={open} onOpenChange={setOpen}>
        {/* The ⌘K palette's dialog (GET-658, round 2): the shared dialog surface, small light group
            labels, inset rows with a soft hover band, keys in the palette's outlined chip. */}
        <DialogContent className="max-w-[440px] gap-0 p-0">
          <div className="px-4 pb-1 pt-4">
            <DialogTitle className="text-[13.5px] font-medium tracking-[-0.01em]">Keyboard shortcuts</DialogTitle>
          </div>
          <div className="flex flex-col px-2 pb-2">
            {SHORTCUTS.map((g) => (
              <section key={g.group}>
                <h3 className="px-2 pb-1 pt-2.5 text-[11px] font-medium text-muted-foreground/60">{g.group}</h3>
                <ul className="flex flex-col">
                  {g.items.map((s) => (
                    <li key={s.label} className="flex h-9 items-center justify-between rounded-lg px-2 text-[13px] transition-colors duration-fast hover:bg-hover">
                      {s.label}
                      <span className="flex items-center gap-1">
                        {s.keys.map((k, i) => (
                          <span key={i} className="flex items-center gap-1">
                            {i > 0 && g.group === "Go to" && <span className="text-[11px] text-muted-foreground/50">then</span>}
                            <Kbd className="rounded-md bg-transparent font-sans font-medium text-muted-foreground/60 shadow-[0_0_0_1px_hsl(var(--border))]">{k}</Kbd>
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
