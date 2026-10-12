import * as React from "react";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * One line, cut with an ellipsis, and the full text in a tooltip only when it was actually
 * cut (standard 9, GET-594). Long names never wrap and never change a row's height.
 */
export function Truncate({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  /** Tooltip text when `children` isn't plain text. */
  title?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [open, setOpen] = React.useState(false);
  // Open only when the text is actually cut; measured at the moment the tooltip wants to open.
  const onOpenChange = (next: boolean) => {
    const el = ref.current;
    setOpen(next && !!el && el.scrollWidth > el.clientWidth + 1);
  };
  return (
    <Tooltip open={open} onOpenChange={onOpenChange}>
      <TooltipTrigger asChild>
        <span ref={ref} className={cn("block min-w-0 truncate", className)}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{title ?? children}</TooltipContent>
    </Tooltip>
  );
}
