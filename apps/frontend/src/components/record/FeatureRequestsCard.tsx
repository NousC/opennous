// What a customer asked us to build (claims about us, GET-969), on their account and person pages.
// Product feedback, so never one of the record's facts; listed beside them so the record says what
// they want from us. A quote from a private message comes without its words (GET-985).
import { ListCard, ListHeader } from "@/components/ui/list";
import { when } from "@/lib/format";

export type FeatureRequest = {
  id: string; what: string | null; content: string; use_case: string | null; quote: string | null;
  speaker: string | null; contact_id: string | null; source_system: string | null; occurred_at: string | null;
};

const SOURCE: Record<string, string> = { slack: "Slack", gmail: "Email", email: "Email", outlook: "Email", linkedin: "LinkedIn" };
const sourceLabel = (s: string | null) => (s ? SOURCE[s.toLowerCase()] ?? (/meet|call|fireflies|granola|gong|zoom|fathom/i.test(s) ? "Call" : null) : null);

export function FeatureRequestsCard({ requests }: { requests?: FeatureRequest[] | null }) {
  if (!requests?.length) return null;
  return (
    <ListCard className="min-w-0">
      <ListHeader title="Feature requests" count={requests.length} />
      <div className="divide-y divide-hairline">
        {requests.map((r) => {
          const meta = [r.speaker, sourceLabel(r.source_system), r.occurred_at ? when(r.occurred_at) : null].filter(Boolean).join(" · ");
          return (
            <div key={r.id} className="space-y-1 px-2 py-2.5">
              {r.what && <div className="text-[13px] font-medium text-foreground">{r.what}</div>}
              <p className="text-[13px] leading-[1.55] text-foreground/85 [overflow-wrap:anywhere]">{r.content}</p>
              {r.quote && <p className="border-l-2 border-hairline pl-2 text-[12.5px] italic leading-[1.5] text-muted-foreground [overflow-wrap:anywhere]">“{r.quote}”</p>}
              {meta && <div className="text-[12px] text-muted-foreground/70">{meta}</div>}
            </div>
          );
        })}
      </div>
    </ListCard>
  );
}
