import React from "react";
import { useInApiShell } from "@/components/shell/apiTopBarContext";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  // On the API plan the shared top bar carries the title (GET-621); what's left of the header is
  // the page's own actions, as a toolbar row under the bar.
  const inApiShell = useInApiShell();
  if (inApiShell) {
    return actions ? <div className="mb-5 flex flex-wrap items-center justify-end gap-2">{actions}</div> : null;
  }
  return (
    <div className="pt-1 mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[21px] font-semibold tracking-[-0.02em] text-foreground leading-tight">{title}</h1>
        {subtitle && <p className="text-[13px] text-muted-foreground/80 mt-1.5 leading-relaxed">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  );
}
