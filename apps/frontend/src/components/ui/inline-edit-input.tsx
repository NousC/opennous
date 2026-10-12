import * as React from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

/**
 * A name edited in place (a title, a table cell). Opens with the current value selected; Enter
 * saves, Esc cancels, and leaving the field saves when the value changed and is valid. A value
 * `validate` refuses is said in a toast and keeps the field open on Enter (on blur it cancels).
 * `onSave` gets the trimmed value, and only when it changed.
 */
export function InlineEditInput({ value: initial, onSave, onCancel, validate, label, maxLength, className }: {
  value: string;
  onSave: (value: string) => void;
  onCancel: () => void;
  validate?: (value: string) => string | null;
  label: string;
  maxLength?: number;
  className?: string;
}) {
  const [value, setValue] = React.useState(initial);
  const done = React.useRef(false);
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    const next = value.trim();
    if (!save || next === initial.trim()) { done.current = true; onCancel(); return; }
    const err = validate?.(next) ?? null;
    if (err) { toast.error(err); return; }
    done.current = true;
    onSave(next);
  };

  return (
    <input
      ref={ref} value={value} maxLength={maxLength}
      aria-label={label} autoComplete="off" spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      }}
      onBlur={() => finish(!(validate?.(value.trim()) ?? null))}
      className={cn(
        "h-7 min-w-0 rounded-md border border-border bg-card px-2 text-[13px] font-medium text-foreground outline-none focus:border-foreground focus:shadow-[0_0_0_3px_rgba(20,20,18,0.06)]",
        className,
      )}
    />
  );
}
