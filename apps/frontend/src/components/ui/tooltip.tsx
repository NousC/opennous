import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * `shortcut` shows the keys after the label ("New task  C"), so people learn shortcuts from the
 * tooltips without a help page (standard 2, GET-601).
 */
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & { shortcut?: string[] }
>(({ className, sideOffset = 4, shortcut, children, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "z-50 overflow-hidden rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-pop animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
      className,
    )}
    {...props}
  >
    {shortcut ? (
      <span className="flex items-center gap-2">
        {children}
        <span className="flex gap-0.5">
          {shortcut.map((k, i) => (
            <kbd key={i} className="inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-background/15 px-1 font-mono text-[10px] font-normal">{k}</kbd>
          ))}
        </span>
      </span>
    ) : children}
  </TooltipPrimitive.Content>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
