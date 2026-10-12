import * as React from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * The owner filter used on every list (GET-594). It replaces "My book / Whole team" and
 * "Owner: Me / Anyone": "Everyone" by default, "Assigned to me" first in the menu, then each
 * person with their count. An empty selection means everyone.
 */
export interface Person {
  id: string;
  name: string;
  /** Open items for this person in the current view. */
  count?: number;
}

export const UNASSIGNED = "__unassigned";

/** Warm, quiet avatar tints; a person keeps the same one everywhere. */
const TINTS = [
  "bg-[#DDE3E8] text-[#3E4A55]",
  "bg-[#E7E3DC] text-[#5A4A33]",
  "bg-[#DCE6DF] text-[#39503F]",
  "bg-[#E4E0EA] text-[#4A4458]",
  "bg-[#EDE3DE] text-[#5C4038]",
  "bg-[#E0E6E6] text-[#3B5052]",
];
export function avatarTint(id: string) {
  // FNV-1a: short ids ("bg", "mr") still spread across the tints.
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return TINTS[((h ^ (h >>> 15)) >>> 0) % TINTS.length];
}
export function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function PersonAvatar({ person, size = 18, ring = false }: { person: Person; size?: number; ring?: boolean }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        avatarTint(person.id),
        ring && "shadow-[0_0_0_2px_hsl(var(--card))]",
      )}
    >
      {initialsOf(person.name)}
    </span>
  );
}

export interface OwnerFilterProps {
  people: Person[];
  /** The viewer, when they're one of `people` — enables "Assigned to me". */
  meId?: string;
  value: string[];
  onChange: (ids: string[]) => void;
  /** Show an "Unassigned" option with this count. */
  unassignedCount?: number;
  className?: string;
}

export function OwnerFilter({ people, meId, value, onChange, unassignedCount, className }: OwnerFilterProps) {
  const me = people.find((p) => p.id === meId);
  const others = people.filter((p) => p.id !== meId);
  const total = people.reduce((n, p) => n + (p.count ?? 0), 0) + (unassignedCount ?? 0);
  const selected = new Set(value);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };

  const label =
    value.length === 0
      ? "Everyone"
      : value.length === 1 && value[0] === meId
        ? "Assigned to me"
        : value.length === 1
          ? value[0] === UNASSIGNED
            ? "Unassigned"
            : (people.find((p) => p.id === value[0])?.name.split(" ")[0] ?? "1 person")
          : `${value.length} people`;
  const faces = (value.length ? people.filter((p) => selected.has(p.id)) : people).slice(0, 3);

  const row = (key: string, on: boolean, onSelect: () => void, content: React.ReactNode, count?: number) => (
    <button
      key={key}
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      onClick={onSelect}
      className="flex h-8 w-full items-center gap-2.5 rounded-[7px] px-2 text-left text-[12.5px] transition-colors duration-fast hover:bg-hover"
    >
      <span
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border-[1.5px]",
          on ? "border-foreground bg-foreground text-background" : "border-border",
        )}
      >
        {on && <Check className="size-2.5" strokeWidth={3.5} />}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">{content}</span>
      {count !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
    </button>
  );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-card pl-1.5 pr-2 text-[12.5px] font-medium shadow-[0_1px_0_rgba(20,20,18,0.04)] transition-colors duration-fast hover:bg-hover data-[state=open]:bg-muted",
            className,
          )}
        >
          <span className="flex -space-x-[5px]">
            {faces.map((p) => (
              <PersonAvatar key={p.id} person={p} ring />
            ))}
          </span>
          {label}
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1.5" role="menu" aria-label="Owner">
        <p className="px-2 pb-1.5 pt-1 text-[11.5px] text-muted-foreground">Owner</p>
        {row("everyone", value.length === 0, () => onChange([]), <span className="font-medium">Everyone</span>, total || undefined)}
        <div className="mx-0.5 my-1 h-px bg-hairline" />
        {me && row(me.id, selected.has(me.id), () => toggle(me.id), <><PersonAvatar person={me} />Assigned to me</>, me.count)}
        {others.map((p) => row(p.id, selected.has(p.id), () => toggle(p.id), <><PersonAvatar person={p} /><span className="truncate">{p.name}</span></>, p.count))}
        {unassignedCount !== undefined &&
          row(
            UNASSIGNED,
            selected.has(UNASSIGNED),
            () => toggle(UNASSIGNED),
            <><span className="inline-flex size-[18px] items-center justify-center rounded-full bg-muted text-[9px] text-muted-foreground">–</span>Unassigned</>,
            unassignedCount,
          )}
      </PopoverContent>
    </Popover>
  );
}
