import {
  ChevronLeft, LogOut, User, Bell, Shield, Plug, Users, Webhook, KeyRound, FolderGit2, Slack,
  Brain, Sparkles, CalendarClock, Building2, Cpu, History, PieChart, Activity, CreditCard, Tags, Wrench, Zap, ScrollText,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { groupNav, type SettingsNavItem } from "./settingsNav";
import { RAIL_STROKE, railActive, railGroupLabel, railIcon, railIconActive, railIdle, railLabel, railLabelActive } from "@/components/shell/rail";

// The settings rail (GET-625, board SettingsRail): replaces the app sidebar while you are in
// Settings. A back arrow, the groups, and the workspace + plan at the foot. No counts, no price.

const ICONS: Record<string, LucideIcon> = {
  profile: User, notifications: Bell, security: Shield,
  integrations: Plug, "company-sources": Users, webhooks: Webhook, "api-keys": KeyRound, repo: FolderGit2, config: Slack,
  memory: Brain, skills: Sparkles, sequences: CalendarClock,
  context: Brain, signals: Zap, general: Building2, members: Users, "activity-log": ScrollText, models: Cpu, changes: History, spend: PieChart, adoption: Activity, billing: CreditCard,
  categories: Tags, admin: Wrench,
};

// The sidebar's own rows (shell/rail.ts): the ⌘K palette's flat selected band, no ring.
const activeRow = cn(railActive, railLabelActive);
const idleRow = cn(railIdle, railLabel);

export function SettingsRail({ items, active, onSelect, onBack, onSignOut, workspaceName, planLabel, backLabel = "Back to app" }: {
  items: SettingsNavItem[];
  active: string;
  onSelect: (item: SettingsNavItem) => void;
  onBack: () => void;
  onSignOut: () => void;
  workspaceName: string;
  planLabel: string;
  backLabel?: string;
}) {
  const groups = groupNav(items);
  const row = (it: SettingsNavItem, strip = false) => {
    const on = it.id === active;
    const Icon = ICONS[it.id] ?? User;
    return (
      <button
        key={it.id}
        type="button"
        onClick={() => onSelect(it)}
        aria-current={on ? "page" : undefined}
        // On a phone the rail is one sideways strip: keep the open section in view.
        ref={strip && on ? (el) => el?.scrollIntoView({ block: "nearest", inline: "center" }) : undefined}
        className={cn(
          "group flex h-[30px] shrink-0 items-center gap-2.5 rounded-lg px-2 text-left text-[13px] tracking-[-0.003em] transition-colors duration-fast",
          on ? activeRow : idleRow,
        )}
      >
        <Icon className={cn("h-[15px] w-[15px] shrink-0", on ? railIconActive : railIcon)} strokeWidth={RAIL_STROKE} />
        <span className="min-w-0 flex-1 truncate">{it.label}</span>
      </button>
    );
  };

  return (
    <nav
      aria-label="Settings"
      className="flex shrink-0 flex-col bg-frame p-2.5 md:h-full md:w-[232px]"
    >
      <div className="mb-1 flex items-center md:mb-2">
        {/* Back is just the arrow; the label is its name and tooltip. */}
        <button
          type="button"
          onClick={onBack}
          aria-label={backLabel}
          title={backLabel}
          className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-fast hover:text-foreground", railIdle, railIcon)}
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={RAIL_STROKE} />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onSignOut}
          aria-label="Log out"
          className={cn("flex h-8 w-8 items-center justify-center rounded-md hover:text-foreground md:hidden", railIcon)}
        >
          <LogOut className="h-[15px] w-[15px]" strokeWidth={RAIL_STROKE} />
        </button>
      </div>

      {/* Desktop: grouped column. Phone: one sideways-scrolling strip of the same rows. */}
      <div className="hidden min-h-0 flex-1 flex-col gap-px overflow-y-auto md:flex">
        {groups.map((g) => (
          <div key={g.group} className="flex flex-col gap-px">
            <div className={cn("px-2 pb-1 pt-4", railGroupLabel)}>{g.group}</div>
            {g.items.map((it) => row(it))}
          </div>
        ))}
      </div>
      <div className="-mx-2.5 flex gap-1 overflow-x-auto px-2.5 pb-0.5 md:hidden">
        {items.map((it) => row(it, true))}
      </div>

      <div className="mt-2 hidden items-center gap-2.5 border-t border-border/60 px-1.5 pb-0.5 pt-2 md:flex">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand text-[11px] font-medium text-white">
          {(workspaceName || "?").trim().charAt(0).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-[1.2]">
          <span className="truncate text-[13px] text-foreground">{workspaceName || "Workspace"}</span>
          <span className="text-[11.5px] text-muted-foreground/60">{planLabel}</span>
        </span>
        <button
          type="button"
          onClick={onSignOut}
          aria-label="Log out"
          title="Log out"
          className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-fast hover:text-foreground", railIcon, railIdle)}
        >
          <LogOut className="h-[15px] w-[15px]" strokeWidth={RAIL_STROKE} />
        </button>
      </div>
    </nav>
  );
}
