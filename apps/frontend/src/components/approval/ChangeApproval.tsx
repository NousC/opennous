// A change Nous proposes to a CRM record, waiting for you (standard 7, GET-617).
//
// Nous never changes a deal on its own. This is the one way it asks: the change on one row,
// Skip or Approve, and after approving a toast that says what changed in which CRM, with Undo
// when the caller can reverse it. If the write fails, the row says nothing changed and stays.
import { useState } from "react";
import { CalendarClock, Check, GitCommitHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useCrm } from "@/hooks/useCrm";
import { ChangeRow } from "@/components/approval/ChangeRow";

export type ProposedChange = {
  /** What changes, in words: "Close date", "Stage", "Amount". */
  field: string;
  record: string;
  from: string | null;
  to: string | null;
  reason?: string | null;
  kind?: "field" | "stage";
};

export function ChangeApproval({ change, onApprove, onSkip, onUndo }: {
  change: ProposedChange;
  /** Writes the change. Throw to report a failure (nothing is shown as changed). */
  onApprove: () => Promise<void>;
  onSkip?: () => void;
  /** Reverses an approved change; enables Undo in the toast. */
  onUndo?: () => Promise<void>;
}) {
  const crm = useCrm();
  const [state, setState] = useState<"pending" | "busy" | "done" | "skipped">("pending");
  const [error, setError] = useState<string | null>(null);
  const crmName = crm.provider ? crm.label : "your CRM";

  const approve = async () => {
    setState("busy");
    setError(null);
    try {
      await onApprove();
      setState("done");
      toast(`${change.field} updated in ${crmName}`, {
        description: `${change.record} · ${change.from ?? "nothing"} → ${change.to ?? "nothing"}`,
        action: onUndo ? {
          label: "Undo",
          onClick: () => {
            onUndo().then(() => setState("pending")).catch(() =>
              toast.error("Couldn't undo that", { description: `The change is still in ${crmName}.` }));
          },
        } : undefined,
      });
    } catch (e) {
      setState("pending");
      setError(`Nothing changed in ${crmName}. ${e instanceof Error ? e.message : "Try again."}`);
    }
  };

  if (state === "skipped") return null;
  const icon = change.kind === "stage" ? <GitCommitHorizontal /> : <CalendarClock />;
  return (
    <ChangeRow
      icon={state === "done" ? <Check /> : icon}
      tone={state === "done" ? "neutral" : "warning"}
      title={state === "done" ? `${change.field} updated in ${crmName}` : `Update ${change.field.toLowerCase()} in ${crmName}`}
      record={change.record}
      from={change.from ?? undefined}
      to={change.to ?? undefined}
      reason={change.reason ?? undefined}
      error={error}
      actions={state === "done" ? null : (
        <>
          {onSkip && <Button variant="ghost" size="sm" disabled={state === "busy"} onClick={() => { setState("skipped"); onSkip(); }}>Skip</Button>}
          <Button variant="outline" size="sm" disabled={state === "busy"} onClick={() => void approve()}>
            {state === "busy" ? "Updating…" : "Approve"}
          </Button>
        </>
      )}
    />
  );
}
