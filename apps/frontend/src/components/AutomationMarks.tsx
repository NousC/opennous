// The marks a flow is drawn with — one per step, at any size (GET-523). The tool it runs on
// when there is one (a Granola call, a HubSpot deal, a Slack channel, a PostHog event), a plain
// glyph when not, and the agent in the app's one accent so the step that does the work reads as
// that step.
import {
  CalendarClock, ChevronRight, Clock, Home, Mail, Webhook, Zap, Filter, Hourglass,
  UserCheck, Radar, Sparkles, MessageSquareReply, MessageSquareDashed,
  Hand, Handshake, Mic,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EntityAvatar } from "@/components/EntityAvatar";
import { LOCAL_LOGO, MODEL_LABEL, MODEL_LOGO, TOOL_DOMAIN, type Tool } from "@/lib/automations";
import type { Step, StepType } from "@/lib/flows";

type Size = "sm" | "lg";
const box = (size: Size) => size === "sm" ? "h-[22px] w-[22px] rounded-[6px]" : "h-[34px] w-[34px] rounded-[10px]";
const glyph = (size: Size) => size === "sm" ? "h-[12px] w-[12px]" : "h-[16px] w-[16px]";

function Glyph({ icon: Icon, size, className }: { icon: typeof Zap; size: Size; className?: string }) {
  return (
    <span className={cn("flex flex-shrink-0 items-center justify-center bg-foreground/[0.07] text-foreground/55", box(size), className)}>
      <Icon className={glyph(size)} strokeWidth={1.8} />
    </span>
  );
}

/** A tool's logo at any size: our own file when we ship one (Gmail, Calendar, HubSpot,
 *  Salesforce), else its favicon. */
export function ToolLogo({ tool, className, textClassName }: { tool: Tool; className: string; textClassName?: string }) {
  if (LOCAL_LOGO[tool.slug]) {
    return (
      <span title={tool.label} className={cn("flex flex-shrink-0 items-center justify-center overflow-hidden bg-white", className)}>
        <img src={LOCAL_LOGO[tool.slug]} alt={tool.label} className="h-[72%] w-[72%] object-contain" />
      </span>
    );
  }
  return <EntityAvatar kind="company" name={tool.label} domain={TOOL_DOMAIN[tool.slug] ?? null} className={className} textClassName={textClassName} />;
}

export function ToolMark({ tool, size }: { tool: Tool; size: Size }) {
  if (LOCAL_LOGO[tool.slug]) return <ToolLogo tool={tool} className={cn("border border-border/70", box(size))} />;
  return (
    <EntityAvatar
      kind="company"
      name={tool.label}
      domain={TOOL_DOMAIN[tool.slug] ?? null}
      className={cn("flex-shrink-0", box(size))}
      textClassName={size === "sm" ? "text-[9px] font-semibold" : "text-[12px] font-semibold"}
    />
  );
}

/** Two or more tools, overlapped — the first two marks, the second tucked under the first. */
function ToolStack({ tools, size }: { tools: Tool[]; size: Size }) {
  return (
    <span className="flex flex-shrink-0 items-center">
      {tools.slice(0, 2).map((t, i) => (
        <span key={t.slug} className={cn("rounded-[7px] ring-2 ring-background", i > 0 && (size === "sm" ? "-ml-2" : "-ml-3"), i === 0 && "z-10")}>
          <ToolMark tool={t} size={size} />
        </span>
      ))}
    </span>
  );
}

const TRIGGER_GLYPH: Record<string, typeof Zap> = {
  call_ended: Mic, before_meeting: CalendarClock, clock: Clock, thread_quiet: MessageSquareDashed, email_received: Mail,
  // Account signals share one mark, so the family reads as one thing wherever it shows.
  reply_owed: MessageSquareReply, health_changed: Radar, champion_quiet: Radar, account_signal: Radar,
  committee_joined: Radar, icp_tier_changed: Radar, expansion_signal: Radar,
  promise_overdue: Radar,
  // Deals with no CRM connected: a deal, not a logo for a CRM you do not have.
  deal_stage_changed: Handshake, deal_closed_won: Handshake, deal_closed_lost: Handshake,
  deal_stalled: Handshake, deal_created: Handshake, webhook_in: Webhook, manual: Hand,
};

export function TriggerMark({ when, tools = [], size = "sm" }: { when: string; tools?: Tool[]; size?: Size }) {
  if (when === "posthog_event") return <ToolMark tool={{ slug: "posthog", label: "PostHog" }} size={size} />;
  if (tools.length > 1) return <ToolStack tools={tools} size={size} />;
  if (tools.length === 1) return <ToolMark tool={tools[0]} size={size} />;
  if (!when) return <Glyph icon={Zap} size={size} className="border border-dashed border-foreground/20 bg-transparent text-foreground/30" />;
  return <Glyph icon={TRIGGER_GLYPH[when] ?? Zap} size={size} />;
}

/** The agent on OpenNous's own models (our credits): our mark. On your own key, the step
 *  shows that provider's logo instead (ModelMark) — the logo says whose bill it runs on. */
export function AgentMark({ size = "sm" }: { size?: Size }) {
  return (
    <span title="Runs on OpenNous" className={cn("flex flex-shrink-0 items-center justify-center border border-border/70 bg-white", box(size))}>
      <img src="/nous-logo.svg" alt="OpenNous" className={size === "sm" ? "h-[15px] w-[15px]" : "h-[24px] w-[24px]"} />
    </span>
  );
}

/** A model provider's own logo — the agent on your Claude, OpenAI or Gemini key. */
export function ModelMark({ model, size = "sm" }: { model: string; size?: Size }) {
  return (
    <span title={MODEL_LABEL[model]} className={cn("flex flex-shrink-0 items-center justify-center border border-border/70 bg-white", box(size))}>
      <img src={MODEL_LOGO[model]} alt={MODEL_LABEL[model] ?? model} className={size === "sm" ? "h-[13px] w-[13px]" : "h-[20px] w-[20px]"} />
    </span>
  );
}

/** An AI step before its model is picked. */
export function AiMark({ size = "sm" }: { size?: Size }) {
  return <Glyph icon={Sparkles} size={size} />;
}

/** One step's mark, by its type. An AI step shows its model's logo: ChatGPT, Claude, or
 *  OpenNous on the defaults. */
export function StepMark({ type, model, size = "sm" }: { type: StepType; model?: string | null; size?: Size }) {
  switch (type) {
    case "agent": return model && MODEL_LOGO[model] ? <ModelMark model={model} size={size} /> : <AiMark size={size} />;
    case "hubspot": return <ToolMark tool={{ slug: "hubspot", label: "HubSpot" }} size={size} />;
    case "gmail": return <ToolMark tool={{ slug: "gmail", label: "Gmail" }} size={size} />;
    case "slack": return <ToolMark tool={{ slug: "slack", label: "Slack" }} size={size} />;
    case "email": return <Glyph icon={Mail} size={size} />;
    case "webhook": return <Glyph icon={Webhook} size={size} />;
    case "only_if": return <Glyph icon={Filter} size={size} />;
    case "wait": return <Glyph icon={Hourglass} size={size} />;
    case "approval": return <Glyph icon={UserCheck} size={size} />;
  }
}

/** A flow with no delivery step still lands on Home — the mark that says so. */
export function HomeMark({ size = "sm" }: { size?: Size }) {
  return <Glyph icon={Home} size={size} />;
}

/** Trigger › each step, small — how a row says what it does without words. Control steps
 *  (only-if, wait, approval) are left out: they shape the flow, the marks say what it does. */
export function MiniFlow({ when, tools, steps }: { when: string; tools: Tool[]; steps: Step[] }) {
  const shown = steps.filter(s => s.type !== "only_if" && s.type !== "wait" && s.type !== "approval").slice(0, 3);
  const sep = <ChevronRight className="h-[11px] w-[11px] flex-shrink-0 text-muted-foreground/35" strokeWidth={2.2} />;
  return (
    <span className="flex flex-shrink-0 items-center gap-1">
      <TriggerMark when={when} tools={tools} />
      {shown.map(s => <span key={s.id} className="flex items-center gap-1">{sep}<StepMark type={s.type} model={s.config.model} /></span>)}
    </span>
  );
}

/** One node of the preview: the mark in a small bordered tile, the way a canvas draws a node. */
function Node({ children, trigger = false, title }: { children: React.ReactNode; trigger?: boolean; title?: string }) {
  return (
    <span title={title} className="relative flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-[9px] border border-border/80 bg-background shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
      {children}
      {trigger && (
        <span className="absolute -left-1.5 -top-1.5 flex h-[14px] w-[14px] items-center justify-center rounded-full bg-foreground text-background ring-2 ring-background">
          <Zap className="h-[8px] w-[8px]" strokeWidth={2.6} fill="currentColor" />
        </span>
      )}
    </span>
  );
}

/**
 * The flow as a row of nodes, n8n-style: the trigger (with its bolt), then every step, joined
 * by a line. Tools are nodes; only-if, wait and approval are dots on the line — they shape the
 * run, they are not places it goes.
 */
export function FlowPreview({ when, tools, steps }: { when: string; tools: Tool[]; steps: Step[] }) {
  const line = <span className="h-px w-3.5 flex-shrink-0 bg-border" />;
  const nodes = steps.slice(0, 6);
  const more = steps.length - nodes.length;
  return (
    <span className="flex items-center">
      <Node trigger title="Trigger">
        {tools.length > 1 ? <ToolStack tools={tools} size="sm" /> : <TriggerMark when={when} tools={tools} />}
      </Node>
      {nodes.map(s => (
        <span key={s.id} className="flex items-center">
          {line}
          {s.type === "only_if" || s.type === "wait" || s.type === "approval"
            ? <span title={s.type === "only_if" ? "Only if" : s.type === "wait" ? "Wait" : "Approval"} className="h-[7px] w-[7px] flex-shrink-0 rounded-full border border-foreground/30 bg-background" />
            : <Node title={s.type}><StepMark type={s.type} model={s.config.model} /></Node>}
        </span>
      ))}
      {more > 0 && <>{line}<span className="text-[11px] text-muted-foreground">+{more}</span></>}
    </span>
  );
}

