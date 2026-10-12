// A section you can correct (GET-426).
//
// The agent writes the document and gets things wrong — a name it misread, a number that has
// since moved, a conclusion you disagree with. Until now the only options were to keep it or
// delete it, which is why so many generated documents go stale rather than getting fixed.
//
// PROSE ONLY, and it says so. A section can be a chart, a table or a metric row, and an
// editor that flattened those to text would destroy them on the first save — silently, since
// the page would still render something. So a section built from blocks renders as it always
// did and simply is not editable, which is the honest limit rather than a lossy save.
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { SectionBody, type ReportSection } from "@/components/ReportBlocks";
import { cn } from "@/lib/utils";

export function EditableSection({
  sec, onSave, citeIndex,
}: {
  sec: ReportSection;
  onSave: (body: string) => Promise<void>;
  /** Turns a cite token into its number, so markers render as links. */
  citeIndex?: (token: string) => number | undefined;
}) {
  const hasBlocks = Array.isArray(sec.blocks) && sec.blocks.length > 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sec.body ?? "");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow to the text rather than scroll inside a box: you are editing a document, not
  // filling in a field, and a fixed-height island in a page of prose reads as a form.
  useEffect(() => {
    if (!editing || !ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${ref.current.scrollHeight}px`;
    ref.current.focus();
  }, [editing, draft]);

  if (hasBlocks || !editing) {
    return (
      <div
        onDoubleClick={() => { if (!hasBlocks) { setDraft(sec.body ?? ""); setEditing(true); } }}
        title={hasBlocks ? undefined : "Double-click to edit"}
        className={cn(!hasBlocks && "cursor-text rounded-md transition-colors hover:bg-accent/30")}
      >
        <SectionBody sec={sec} citeIndex={citeIndex} />
      </div>
    );
  }

  const commit = async () => {
    if (draft === (sec.body ?? "")) { setEditing(false); return; }
    setSaving(true);
    try { await onSave(draft); setEditing(false); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <textarea
        ref={ref}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        // Escape abandons, ⌘-Enter commits. Blur commits too, because the common ending is
        // clicking away and nobody should lose a correction to a misplaced click.
        onKeyDown={e => {
          if (e.key === "Escape") { setDraft(sec.body ?? ""); setEditing(false); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void commit();
        }}
        onBlur={() => void commit()}
        className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-[15px] leading-[1.75] text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        {saving && <Loader2 className="h-3 w-3 animate-spin" />}
        {saving ? "Saving" : "Escape to discard · ⌘↵ to save"}
      </p>
    </div>
  );
}
