// A claim as a tag (GET-799, GET-801, GET-805): its words on its category's colour, no dot, that shows
// the claim behind it on hover or keyboard focus — its kind, status and date, the fact, the quote,
// who said it and a link to the call or email. Click pins it open on touch screens.
import { SlackText } from "@/components/record/SlackText";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { day } from "@/lib/format";
import { FactSourceLink, factSource } from "./SourceLine";
import type { Note } from "./RecordParts";

export function ClaimHoverTag({ text, color, kind, note, who, extra }: {
  text: string;
  color: string;
  /** "Objection", "Budget": the card's first line. */
  kind: string;
  /** The claim behind the tag; a tag with none (a decider from the org chart) shows `extra` only. */
  note?: Note | null;
  who?: string | null;
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const show = () => { if (timer.current) window.clearTimeout(timer.current); setOpen(true); };
  const hide = () => { if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(false), 120); };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (r) setPos({ top: Math.min(r.bottom + 6, window.innerHeight - 220), left: Math.max(8, Math.min(r.left, window.innerWidth - 316)) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);

  const status = String(note?.metadata?.status ?? "").toLowerCase();
  const statusWord = status === "resolved" || status === "addressed" ? "Resolved" : null;
  const quote = typeof note?.metadata?.quote === "string" && note.metadata.quote.trim() ? note.metadata.quote.trim() : null;

  return (
    <>
      <button ref={ref} type="button" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
        onClick={() => setOpen(v => !v)} aria-expanded={open}
        className="inline-flex min-h-[24px] max-w-full items-center rounded-md px-2 py-[3px] text-left text-[12.5px] leading-snug transition-[filter] duration-fast hover:brightness-95"
        style={{ background: `${color}14`, color }}>
        <span className="line-clamp-2 [overflow-wrap:anywhere]">{text}</span>
      </button>
      {open && pos && createPortal(
        <div role="tooltip" onMouseEnter={show} onMouseLeave={hide}
          className="fixed z-[71] w-[300px] space-y-1.5 rounded-xl bg-popover p-3 text-popover-foreground shadow-[0_6px_24px_rgba(0,0,0,0.10),0_0_0_1px_rgba(0,0,0,0.06)]"
          style={{ top: pos.top, left: pos.left }}>
          <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <span style={{ color }}>{kind}</span>
            <span className="ml-auto text-muted-foreground/70">{[statusWord, note?.created_at ? day(note.created_at) : null].filter(Boolean).join(" · ")}</span>
          </div>
          {note?.content && <p className="text-[13px] leading-snug text-foreground [overflow-wrap:anywhere]">{note.content}</p>}
          {quote && <p className="text-[12px] italic leading-snug text-muted-foreground [overflow-wrap:anywhere]">“<SlackText text={String(quote)} />”</p>}
          {extra}
          {(who || (note && factSource(note))) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-[11.5px] text-muted-foreground/70">
              {who && <span>{who}</span>}
              {note && factSource(note) && <>{who && <span aria-hidden className="text-border">·</span>}<FactSourceLink note={note} /></>}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
