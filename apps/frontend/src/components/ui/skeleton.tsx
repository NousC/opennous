import { cn } from "@/lib/utils";

/** A placeholder block. Loading screens draw the real shape of what's coming, never a spinner. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-hairline", className)} {...props} />;
}

/** Table-shaped loading rows: a logo square, two text bars, a short bar on the right. */
function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  const widths = ["30%", "24%", "34%", "27%"];
  return (
    <div className={className} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-[42px] items-center gap-3.5 border-b border-hairline px-4 last:border-b-0">
          <Skeleton className="size-[18px] rounded-[5px]" />
          <Skeleton className="h-2.5" style={{ width: widths[i % widths.length] }} />
          <Skeleton className="h-2.5 w-[14%]" />
          <span className="flex-1" />
          <Skeleton className="h-2.5 w-[10%]" />
        </div>
      ))}
    </div>
  );
}

export { Skeleton, SkeletonRows };
