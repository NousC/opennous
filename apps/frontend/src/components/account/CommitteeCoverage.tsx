// Buying-committee coverage, on the Org chart tab (palette rows since GET-658): are the key roles present, are we engaged
// with them, and where are the holes. From the roles and last-activity the page already has.
// Cold = no touch in 30 days.
//
// It sat on the Overview once and left an empty half-row beside it; the org chart is where a rep
// is already asking "who is on this", so it lives there.
import { ListCard, ListHeader, ListMeta, ListRow, ListText } from "@/components/ui/list";
import { PersonAvatar } from "@/components/ui/owner-filter";

export type CommitteePerson = { id: string; name: string; role?: string | null; last_activity_at: string | null };

const KEY_ROLES = [
  { key: "decision_maker", label: "Decision maker" },
  { key: "economic_buyer", label: "Economic buyer" },
  { key: "champion", label: "Champion" },
];

export function CommitteeCoverage({ stakeholders }: { stakeholders: CommitteePerson[] }) {
  if (!stakeholders.length) return null;
  const now = Date.now();
  const isCold = (s: CommitteePerson) => !s.last_activity_at || (now - new Date(s.last_activity_at).getTime()) / 86_400_000 > 30;
  const byRole = (r: string) => stakeholders.filter(s => (s.role ?? "contact") === r);
  const engaged = stakeholders.filter(s => !isCold(s)).length;
  const covered = KEY_ROLES.filter(r => byRole(r.key).length).length;
  const blockers = byRole("blocker");
  const coldKey = KEY_ROLES.flatMap(r => byRole(r.key)).filter(isCold);

  // The palette's card: one row per key role, led by the person's face (a dashed tile when nobody
  // holds it), the role at 13px with the name beside it, and engaged / cold / missing on the right.
  return (
    <ListCard className="mb-4 min-w-0">
      <ListHeader title="Buying committee coverage"
        right={<span className="text-[12px] tabular-nums text-muted-foreground/60">{covered}/{KEY_ROLES.length} key roles · {engaged}/{stakeholders.length} engaged</span>} />
      {KEY_ROLES.map(r => {
        const people = byRole(r.key);
        const person = people.find(p => !isCold(p)) || people[0];
        const has = people.length > 0;
        const cold = has && !people.some(p => !isCold(p));
        return (
          <ListRow key={r.key}>
            {person
              ? <PersonAvatar person={{ id: person.id, name: person.name }} size={24} />
              : <span className="h-6 w-6 flex-shrink-0 rounded-full border border-dashed border-border" />}
            <ListText title={r.label} sub={has ? person?.name : "Not identified"} />
            <ListMeta className={cold ? "text-warning" : !has ? "text-muted-foreground/50" : undefined}>
              {!has ? "Gap" : cold ? "Cold" : "Engaged"}
            </ListMeta>
          </ListRow>
        );
      })}
      {(blockers.length > 0 || coldKey.length > 0) && (
        <div className="flex flex-col gap-0.5 px-2 pb-1.5 pt-1 text-[12px] leading-relaxed text-muted-foreground/70">
          {coldKey.length > 0 && <span>Re-engage {coldKey.map(s => s.name).join(", ")}: no touch in 30 days or more.</span>}
          {blockers.length > 0 && <span className="text-risk">{blockers.map(b => b.name).join(", ")} blocking.</span>}
        </div>
      )}
    </ListCard>
  );
}
