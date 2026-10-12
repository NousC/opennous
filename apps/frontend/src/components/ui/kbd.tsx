import { cn } from "@/lib/utils";

/** One key, drawn as a small keycap (GET-601). Used in tooltips, the ? sheet and the search bar. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded px-1 font-mono text-[10.5px] font-normal text-muted-foreground",
        "bg-hover shadow-[inset_0_-1px_0_hsl(var(--input)),0_0_0_1px_hsl(var(--border))]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
