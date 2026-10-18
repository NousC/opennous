// The account's next step on its Overview (GET-800, GET-804), chosen by packages/core
// selectNextStep: the latest follow-up AGREED in the last two weeks across calls, meetings and
// emails (an action item from a call page, a commitment in an email), else a meeting already
// booked. It says what it is and when: "Friday follow-up: send the revised proposal", agreed 7 Oct
// on the call. With nothing agreed in two weeks it says so, instead of surfacing a month-old open
// task as if it were the plan.
import { ListCard } from "@/components/ui/list";
import { H3 } from "@/components/record/OverviewParts";
import { day } from "@/lib/format";

export type NextStep = {
  status: "agreed" | "scheduled" | "none";
  title: string | null;
  due_at: string | null;
  said_at?: string | null;
  /** When it was agreed (GET-804). */
  agreed_at?: string | null;
  quote?: string | null;
  items?: string[];
  conversation: { kind: "meeting" | "call" | "email" | "conversation"; at: string; title: string | null } | null;
  reason?: string | null;
};

const KIND: Record<string, string> = { meeting: "call", call: "call", email: "email" };
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Friday follow-up" when it is due within the week ahead, else "Follow-up due 21 Oct", else "Follow-up". */
function whenLabel(dueAt: string | null): string {
  const t = dueAt ? Date.parse(dueAt) : NaN;
  if (!Number.isFinite(t)) return "Follow-up";
  const days = (t - Date.now()) / 86_400_000;
  if (days < -1) return `Follow-up, was due ${day(dueAt)}`;
  if (days <= 6) return `${WEEKDAY[new Date(t).getDay()]} follow-up`;
  return `Follow-up due ${day(dueAt)}`;
}

export function NextStepCard({ step }: { step: NextStep | null | undefined }) {
  if (!step) return null;
  const conv = step.conversation;
  const more = (step.items ?? []).filter(t => t !== step.title);
  const agreed = step.agreed_at ?? step.said_at ?? null;
  const where = conv && KIND[conv.kind] ? ` on the ${KIND[conv.kind]}${conv.title ? `, ${conv.title}` : ""}` : "";
  return (
    <ListCard className="min-w-0">
      <div className="flex min-h-8 items-center gap-2 px-2 pb-1 pt-0.5">
        <H3>Next step</H3>
      </div>
      {step.status === "none" || !step.title ? (
        <div className="px-2 pb-1.5">
          <p className="text-[13px] text-foreground/85">{step.reason ?? "No next step agreed in the last two weeks"}</p>
          {conv && <p className="mt-0.5 text-[11.5px] text-muted-foreground/60">Last conversation {day(conv.at)}</p>}
        </div>
      ) : step.status === "scheduled" ? (
        <div className="px-2 pb-1.5">
          <p className="text-[13px] leading-snug text-foreground">Meeting booked: {step.title}</p>
          {step.due_at && <p className="mt-0.5 text-[11.5px] text-muted-foreground/60">On {day(step.due_at)}</p>}
        </div>
      ) : (
        <div className="px-2 pb-1.5">
          <p className="text-[13px] leading-snug text-foreground">
            <span className="text-muted-foreground">{whenLabel(step.due_at)}:</span> {step.title}
          </p>
          {step.quote && <p className="mt-0.5 text-[12px] italic leading-snug text-muted-foreground">“{step.quote}”</p>}
          {agreed && <p className="mt-0.5 text-[11.5px] text-muted-foreground/60">Agreed {day(agreed)}{where}</p>}
          {more.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {more.slice(0, 4).map(t => <li key={t} className="text-[12.5px] leading-snug text-foreground/75">· {t}</li>)}
            </ul>
          )}
        </div>
      )}
    </ListCard>
  );
}
