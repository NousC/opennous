import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";

// The team member who owns an account or a person — a face plus a name. Shows the
// member's profile picture when we have one, otherwise their initial. Kept quiet
// and small so it reads as "whose desk this is", not a heading. Mirrors the
// OwnerAvatar on the Tasks page so ownership looks the same everywhere.
export function OwnerBadge({
  name,
  avatar,
}: {
  name?: string | null;
  avatar?: string | null;
}) {
  if (!name) return <span className="text-muted-foreground/40">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0" title={name}>
      <Avatar className="h-5 w-5 border border-border flex-shrink-0">
        <AvatarImage src={avatar || undefined} alt={name} />
        <AvatarFallback className="text-[8.5px] font-semibold bg-muted text-muted-foreground">
          {name.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{name}</span>
    </span>
  );
}

/** Every owner of an account or deal, in order (the effective owner first). Two reps on one
 *  account is what the record should show, not a coin toss between them (GET-268). */
export function OwnersBadges({ owners }: { owners?: { name?: string | null; avatar?: string | null }[] | null }) {
  const list = (owners ?? []).filter(o => o?.name);
  if (!list.length) return <span className="text-muted-foreground/40">—</span>;
  return (
    <span className="flex flex-col gap-1 min-w-0">
      {list.map((o, i) => <OwnerBadge key={`${o.name}-${i}`} name={o.name} avatar={o.avatar} />)}
    </span>
  );
}
