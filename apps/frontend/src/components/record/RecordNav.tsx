// "3 of 19" and the up/down chevrons after a record's breadcrumb (GET-650), with K and J. Only
// when the record was opened from a list (listOrder.ts); a record reached any other way shows
// nothing. The record page is the one on top while it is mounted, so its K and J win over a list's.
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTopBarSlot } from "@/components/shell/topBar";
import { useHotkey } from "@/lib/hotkeys";
import { num } from "@/lib/format";
import { readRecordNav } from "./listOrder";

export function RecordNav() {
  const slot = useTopBarSlot();
  const location = useLocation();
  const navigate = useNavigate();
  const nav = readRecordNav(location.state);
  const i = nav ? nav.paths.indexOf(location.pathname) : -1;
  const on = !!nav && i >= 0;
  const what = /\/deals\//.test(location.pathname) ? "deal" : "account";

  // Replace, not push: Back from the fifth record lands on the list, not on the fourth. Only the
  // list travels on; anything else the list handed the first record (its name) was about that one.
  const go = (step: number) => {
    if (!nav || i < 0) return;
    const to = nav.paths[i + step];
    if (to) navigate(to, { replace: true, state: { recordNav: nav } });
  };
  useHotkey("k", () => go(-1), on);
  useHotkey("j", () => go(1), on);

  if (!on || !slot || !nav) return null;
  const prev = i > 0;
  const next = i < nav.paths.length - 1;
  const btn = "inline-flex size-7 items-center justify-center rounded-lg text-ink-2 transition-colors duration-fast hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5";
  return createPortal(
    // Not on a phone: the top bar there has room for the breadcrumb and little else.
    <div className="ml-2 flex flex-shrink-0 items-center gap-2 max-sm:hidden">
      <span className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={btn} disabled={!prev} onClick={() => go(-1)} aria-label={`Previous ${what}`}><ChevronUp /></button>
          </TooltipTrigger>
          <TooltipContent shortcut={["K"]}>Previous {what}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className={btn} disabled={!next} onClick={() => go(1)} aria-label={`Next ${what}`}><ChevronDown /></button>
          </TooltipTrigger>
          <TooltipContent shortcut={["J"]}>Next {what}</TooltipContent>
        </Tooltip>
      </span>
      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
        {num(nav.start + i + 1)} of {num(nav.total)}
      </span>
    </div>,
    slot,
  );
}
