import React, { useState } from "react";
import {
  CalendarClock,
  PenLine,
  ShieldAlert,
  Target,
  Send,
  Brain,
  Copy,
  Check,
  Lock,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type PromptGroup = {
  title: string;
  icon: React.ElementType;
  prompts: string[];
  gated?: boolean; // requires Pro/Scale (cloud) to use
};

// Concrete, copy-paste-ready prompts that map to what Nous actually knows:
// meetings, accounts, customer signal, pipeline, outbound/lead-lists and the GTM
// context/ICP. Specific on purpose — they show exactly what an agent can do here.
const GROUPS: PromptGroup[] = [
  {
    title: "Before a call",
    icon: CalendarClock,
    prompts: [
      "Brief me on today's meeting with acme.com — who's attending, what they care about, and any open threads.",
      "What's changed at stripe.com since our last conversation?",
      "Give me three talking points for my call with the VP of Sales at acme.com.",
    ],
  },
  {
    title: "Follow-ups & writing",
    icon: PenLine,
    prompts: [
      "Draft a follow-up to acme.com from today's call referencing what they cared about and the agreed next step.",
      "Recap all my meetings this week with a clear next action for each.",
      "Who have I gone quiet on in the last two weeks — draft a re-engagement note for each.",
    ],
  },
  {
    title: "Customers & risk",
    icon: ShieldAlert,
    prompts: [
      "Which customers showed risk signals this month, and what triggered them?",
      "What complaints and themes are repeating across customer calls in the last 30 days?",
      "Summarize every touchpoint with acme.com this quarter and tell me how the relationship is trending.",
    ],
  },
  {
    title: "Prospects & pipeline",
    icon: Target,
    prompts: [
      "Which open prospects best fit our ICP and should I prioritize this week?",
      "What roles and seniority are most of my active prospects in?",
      "Which deals have gone cold, and what was the last thing that happened on each?",
    ],
  },
  {
    title: "Leads",
    icon: Send,
    gated: true,
    prompts: [
      "How many positive replies did our outbound campaigns get this week, and which messages drove them?",
      "Which lead list is converting best, and what do the repliers have in common?",
      "What's our reply rate by channel — email vs LinkedIn — over the last 30 days? Report it with a graph.",
      "Which leads replied positively but haven't been followed up on yet?",
    ],
  },
  {
    title: "GTM context",
    icon: Brain,
    prompts: [
      "What's our ICP, and how does acme.com score against it?",
      "What have we learned about what works in outbound over the last month?",
      "How many inbound leads from LinkedIn did we get this month, broken down by week?",
    ],
  },
];

function PromptLine({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };
  return (
    <button
      onClick={copy}
      className="group flex w-full items-start gap-2.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 text-left transition-colors hover:border-white/20 hover:bg-white/[0.04]"
    >
      <span className="mt-px select-none font-mono text-[12.5px] font-semibold leading-relaxed text-orange-400">{">"}</span>
      <span className="flex-1 font-mono text-[12.5px] leading-relaxed text-white/75 group-hover:text-white">
        {prompt}
      </span>
      <span
        className={`mt-px flex flex-shrink-0 items-center gap-1 text-[10.5px] font-medium transition-opacity ${
          copied ? "text-orange-400 opacity-100" : "text-white/30 opacity-0 group-hover:opacity-100"
        }`}
      >
        {copied ? (
          <><Check className="h-3 w-3" />copied</>
        ) : (
          <><Copy className="h-3 w-3" />copy</>
        )}
      </span>
    </button>
  );
}

function LockedLeads({ prompts }: { prompts: string[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-orange-500/25 bg-orange-500/[0.06] p-4">
        <div className="mb-1.5 flex items-center gap-2">
          <Lock className="h-3.5 w-3.5 text-orange-400" />
          <span className="rounded bg-orange-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-orange-400">
            Enterprise
          </span>
        </div>
        <p className="font-mono text-[12.5px] text-white/80">
          Lead &amp; campaign analytics is available on Pro and above.
        </p>
        <p className="mt-1 font-mono text-[11px] text-white/40">
          Outbound replies, lead-list conversion, and reply rate by channel — upgrade to unlock.
        </p>
      </div>
      {/* dimmed preview of what they'd get */}
      <div className="pointer-events-none flex select-none flex-col gap-1.5 opacity-40">
        {prompts.map((p) => (
          <div
            key={p}
            className="flex items-start gap-2.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
          >
            <span className="mt-px font-mono text-[12.5px] font-semibold leading-relaxed text-orange-400">{">"}</span>
            <span className="flex-1 font-mono text-[12.5px] leading-relaxed text-white/75">{p}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AskAgentsModal({
  open,
  onOpenChange,
  leadsUnlocked = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadsUnlocked?: boolean;
}) {
  const [active, setActive] = useState(0);
  const group = GROUPS[active];
  const locked = !!group.gated && !leadsUnlocked;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl p-0 overflow-hidden gap-0">
        <DialogHeader className="px-6 pt-6 pb-5 border-b border-gray-200/60 dark:border-white/[0.08]">
          <DialogTitle>Ask your agents</DialogTitle>
        </DialogHeader>

        <div className="flex h-[62vh] max-h-[480px]">
          {/* Left rail — categories */}
          <nav className="w-52 flex-shrink-0 border-r border-gray-200/60 dark:border-white/[0.08] p-2 overflow-y-auto">
            {GROUPS.map((g, i) => {
              const isActive = i === active;
              const gLocked = !!g.gated && !leadsUnlocked;
              return (
                <button
                  key={g.title}
                  onClick={() => setActive(i)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors ${
                    isActive
                      ? "bg-gray-100 dark:bg-white/[0.06]"
                      : "hover:bg-gray-100/60 dark:hover:bg-white/[0.03]"
                  }`}
                >
                  <g.icon
                    className={`h-4 w-4 flex-shrink-0 ${
                      isActive
                        ? "text-gray-900 dark:text-white"
                        : "text-gray-400 dark:text-white/40"
                    }`}
                    strokeWidth={isActive ? 2 : 1.75}
                  />
                  <span
                    className={`text-[13px] leading-tight ${
                      isActive
                        ? "font-semibold text-gray-900 dark:text-white"
                        : "text-gray-600 dark:text-white/50"
                    }`}
                  >
                    {g.title}
                  </span>
                  {gLocked && (
                    <Lock className="ml-auto h-3 w-3 flex-shrink-0 text-orange-400/70" />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Right — prompts framed as a real Claude Code session */}
          <div className="flex-1 p-3 overflow-hidden">
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0c0c0c]">
              {/* terminal title bar */}
              <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-white/[0.08] px-3.5 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#ff8c42]" />
                <span className="ml-2 font-mono text-[11px] text-white/30">
                  claude — {group.title.toLowerCase().replace(/[^a-z]+/g, "-")}
                </span>
              </div>

              {/* terminal body */}
              <div className="flex-1 overflow-y-auto p-3">
                {/* Claude Code startup banner */}
                <div className="mb-4 flex items-start gap-3 px-0.5">
                  <img
                    src="/provider-logos/claude.svg"
                    alt="Claude"
                    className="h-8 w-8 flex-shrink-0 rounded-md"
                  />
                  <div className="font-mono leading-tight">
                    <div className="text-[12.5px] text-white/90">
                      <span className="font-semibold">Claude Code</span>{" "}
                      <span className="text-white/35">v2.1.167</span>
                    </div>
                    <div className="text-[10.5px] text-white/40">Opus 4.8 (1M context) · Claude Max</div>
                    <div className="text-[10.5px] text-white/30">~/nous</div>
                  </div>
                </div>

                {locked ? (
                  <LockedLeads prompts={group.prompts} />
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {group.prompts.map((p) => (
                      <PromptLine key={p} prompt={p} />
                    ))}
                  </div>
                )}
              </div>

              {/* terminal status footer */}
              <div className="flex-shrink-0 border-t border-white/[0.08] px-3.5 py-2">
                <span className="font-mono text-[10.5px] text-white/30">
                  <span className="text-orange-400">»</span> click a prompt to copy it into your agent
                </span>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
