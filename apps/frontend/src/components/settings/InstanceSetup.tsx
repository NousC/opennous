// Settings → Instance setup, a self-hosted install only (GET-837). What the operator's nous.env
// has configured, read live from GET /api/instance/setup: the AI providers and which model runs
// each job, the integrations, email, the agent. Self-host has no setup pop-up; this page is where
// an operator sees what works and what to set. Everything here is changed in nous.env, then
// `docker compose --env-file nous.env up -d`, so the page explains and gives the lines to paste.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsKit";
import { CodeSnippet } from "@/components/connect/shared";
import { GetDataIn } from "@/components/settings/GetDataIn";
import { cn } from "@/lib/utils";

const apiUrl = import.meta.env.VITE_API_URL ?? "";
const APPLY = "docker compose --env-file nous.env up -d";

type Job = { tier: string; label: string; model: string; route: "anthropic" | "openai_compatible"; ready: boolean; fallback: string | null; fallbackReady: boolean | null };
type Integration = { id: string; name: string; kind: string; ready: boolean; needs: string[]; guide?: string };
type Setup = {
  guide: string;
  address: { domain: string | null; public: boolean; guide: string };
  ai: { providers: { anthropic: boolean; claudeVia?: "openrouter" | "anthropic" | null; openaiCompatible: boolean; endpoint: string; openRouter: boolean; local: boolean }; jobs: Job[] };
  email: { ready: boolean; needs: string[]; guide: string };
  integrations: Integration[];
  agent: { key_created: boolean; connected: boolean };
};

// Recommended setups. Relative cost only: prices move every month and we do not print numbers we
// cannot stand behind, so each card says where to compare live prices instead.
const PRESETS: { name: string; when: string; cost: string; lines: string }[] = [
  {
    name: "What OpenNous Cloud runs",
    when: "One OpenRouter key: DeepSeek v4.1 Flash reads calls and email (GLM 5.2 as its fallback), GLM 5.2 writes, Claude Haiku runs the Insights board. Hosts pinned for steady quality.",
    cost: "$",
    lines: "OPENROUTER_API_KEY=sk-or-…\nEXTRACTION_MODEL=deepseek/deepseek-v4.1-flash\nEXTRACTION_PROVIDER=Novita,DeepInfra,BaseTen\nEXTRACTION_FALLBACK_MODEL=z-ai/glm-5.2\nEXTRACTION_FALLBACK_PROVIDER=Z.AI,Novita,Mistral\nWRITING_MODEL=z-ai/glm-5.2\nINSIGHT_BOARD_MODEL=anthropic/claude-haiku-4.5",
  },
  {
    name: "Anthropic only",
    when: "One key, one vendor. Haiku reads, Sonnet writes.",
    cost: "$$",
    lines: "ANTHROPIC_API_KEY=sk-ant-…\nEXTRACTION_MODEL=claude-haiku-5-5\nWRITING_MODEL=claude-sonnet-5-5\nINSIGHT_BOARD_MODEL=claude-haiku-5-5",
  },
  {
    name: "Best quality",
    when: "Opus writes your summaries and reports, Sonnet reads. For when the writing matters most.",
    cost: "$$$",
    lines: "ANTHROPIC_API_KEY=sk-ant-…\nEXTRACTION_MODEL=claude-sonnet-5-5\nWRITING_MODEL=claude-opus-5-5\nINSIGHT_BOARD_MODEL=claude-sonnet-5-5",
  },
  {
    name: "OpenRouter only",
    when: "One key for every vendor. Swap any model by its OpenRouter id.",
    cost: "$",
    lines: "OPENROUTER_API_KEY=sk-or-…\nEXTRACTION_MODEL=anthropic/claude-haiku-4.5\nWRITING_MODEL=z-ai/glm-5.2\nINSIGHT_BOARD_MODEL=anthropic/claude-haiku-4.5",
  },
  {
    name: "Any OpenAI-compatible provider",
    when: "OpenAI, Groq, Together, Fireworks, LiteLLM: point at its endpoint and use its model ids.",
    cost: "varies",
    lines: "LLM_BASE_URL=https://api.your-provider.com/v1\nLLM_API_KEY=…\nEXTRACTION_MODEL=<model id>\nWRITING_MODEL=<model id>\nINSIGHT_BOARD_MODEL=<model id>",
  },
  {
    name: "Fully local",
    when: "Ollama on your own hardware: nothing leaves the machine. Quality drops on smaller models.",
    cost: "free",
    lines: "LLM_BASE_URL=http://host.docker.internal:11434/v1\nEXTRACTION_MODEL=qwen2.5:32b\nWRITING_MODEL=qwen2.5:32b\nINSIGHT_BOARD_MODEL=qwen2.5:32b",
  },
];

function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={cn(
      "inline-flex h-6 items-center gap-1 rounded-md px-2 text-[12px] font-medium",
      ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    )}>
      {ok && <Check className="h-3 w-3" strokeWidth={2.4} />}{children}
    </span>
  );
}

const Env = ({ names }: { names: string[] }) => (
  <span className="font-mono text-[11px] text-muted-foreground">{names.join(", ")}</span>
);

const GuideLink = ({ href, children = "Guide" }: { href: string; children?: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
    {children}<ExternalLink className="h-3 w-3" />
  </a>
);

// The model's maker, from its id ("z-ai/glm-5.2" → Z.ai), for the Models rows (GET-867).
const MODEL_VENDOR: [RegExp, string][] = [
  [/^(anthropic\/|claude-)/, "anthropic"], [/^deepseek\//, "deepseek"], [/^z-ai\//, "zai"],
  [/^moonshotai\//, "moonshot"], [/^openai\//, "openai"], [/^meta-llama\//, "meta"],
  [/^qwen\//, "alibaba"], [/^minimax\//, "minimax"],
];

function ModelLogo({ model }: { model: string }) {
  const vendor = MODEL_VENDOR.find(([re]) => re.test(model))?.[1];
  return vendor
    ? <img src={`/model-logos/${vendor}.png`} alt="" className="h-5 w-5 rounded" />
    : <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground">AI</span>;
}

function providerOf(job: Job, setup: Setup) {
  if (job.route === "anthropic") return "Anthropic";
  return setup.ai.providers.openRouter ? "OpenRouter" : setup.ai.providers.endpoint;
}

export function InstanceSetup() {
  const { session, userData } = useAuth();
  const token = session?.access_token ?? "";
  const workspaceId = (userData as { workspace?: { id?: string } } | null)?.workspace?.id ?? "";
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !workspaceId) return;
    fetch(`${apiUrl}/api/instance/setup?workspaceId=${encodeURIComponent(workspaceId)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? setSetup(await r.json()) : setError(r.status === 403 ? "Only owners and admins can see this." : "Could not load the instance setup.")))
      .catch(() => setError("Could not load the instance setup."));
  }, [token, workspaceId]);

  if (error) return <p className="px-2 text-[13px] text-muted-foreground">{error}</p>;
  if (!setup) return <div className="flex justify-center py-10"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;

  const { ai } = setup;
  return (
    <>
      <p className="mb-5 px-1 text-[13px] leading-relaxed text-muted-foreground">
        Everything here is set in <span className="font-mono text-[12px]">nous.env</span> on your server. Change it, then run{" "}
        <span className="font-mono text-[12px]">{APPLY}</span>.
      </p>

      <SettingsGroup title="Public address">
        <SettingsRow label={setup.address.domain ?? "No API domain set"}
          hint={setup.address.public
            ? "Granola, HubSpot and Fireflies can send new calls and changes here as they happen."
            : "Only this machine or network can reach it, so tools cannot send live updates (connecting still works, and data arrives through the import and the backfill). Point your own domain at the server to receive them."}>
          {setup.address.public ? <Status ok>Reachable</Status> : <><Status ok={false}>Local only</Status><GuideLink href={setup.address.guide}>How</GuideLink></>}
        </SettingsRow>
      </SettingsGroup>

      <GetDataIn jobs={ai.jobs} providerLabel={ai.providers.openRouter ? "OpenRouter" : ai.providers.endpoint} />

      <SettingsGroup title="AI providers">
        <SettingsRow label="Anthropic" hint={ai.providers.claudeVia === "openrouter" ? "Claude models (claude-…) run through OpenRouter. An Anthropic key is used only without an OpenRouter key." : "Claude models, by their Anthropic id (claude-…)."}
          leading={<img src="/model-logos/anthropic.png" alt="" className="h-5 w-5 rounded" />}>
          {ai.providers.claudeVia === "openrouter" ? <Status ok>Via OpenRouter</Status>
            : ai.providers.anthropic ? <Status ok>Key set</Status>
            : ai.jobs.some((j) => j.route === "anthropic") ? <><Status ok={false}>No key</Status><Env names={["ANTHROPIC_API_KEY"]} /></>
            : <span className="text-[12px] text-muted-foreground">Not used</span>}
        </SettingsRow>
        <SettingsRow
          label={ai.providers.openRouter ? "OpenRouter" : "OpenAI-compatible endpoint"}
          hint={ai.providers.openRouter ? "Every other vendor (GLM, DeepSeek, Kimi, GPT…) by its OpenRouter id." : `Every model that is not claude-…, served by ${ai.providers.endpoint}${ai.providers.local ? " on your network" : ""}.`}
          leading={ai.providers.openRouter
            ? <img src="/model-logos/openrouter.png" alt="" className="h-5 w-5 rounded" />
            : <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground">AI</span>}>
          {ai.providers.openaiCompatible ? <Status ok>Ready</Status> : <><Status ok={false}>No key</Status><Env names={ai.providers.openRouter ? ["OPENROUTER_API_KEY"] : ["LLM_API_KEY"]} /></>}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Models">
        {ai.jobs.map((j) => (
          <SettingsRow key={j.tier} label={j.label} leading={<ModelLogo model={j.model} />}
            hint={<><span className="font-mono">{j.model}</span> · {providerOf(j, setup)}</>}>
            {j.ready
              ? <Status ok>Ready</Status>
              : j.fallback && j.fallbackReady
                ? <span className="text-right text-[12px] text-amber-700 dark:text-amber-400">No key for this model: runs on <span className="font-mono">{j.fallback}</span></span>
                : <Status ok={false}>Not working</Status>}
          </SettingsRow>
        ))}
        <p className="px-2 pb-2 pt-1 text-[12px] leading-relaxed text-muted-foreground">
          Change a job's model with <span className="font-mono">EXTRACTION_MODEL</span>, <span className="font-mono">WRITING_MODEL</span> or{" "}
          <span className="font-mono">INSIGHT_BOARD_MODEL</span>. An id that starts with <span className="font-mono">claude-</span> runs on {ai.providers.claudeVia === "openrouter" ? "OpenRouter" : "your Anthropic key"}; any other id runs on {ai.providers.openRouter ? "OpenRouter" : ai.providers.endpoint}.
        </p>
      </SettingsGroup>

      <SettingsGroup title="Recommended setups">
        <div className="grid gap-2 p-1">
          {PRESETS.map((p) => (
            <div key={p.name} className="flex flex-col gap-2 rounded-xl border border-border/70 bg-background p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium text-foreground">{p.name}</span>
                <span className="font-mono text-[11.5px] text-muted-foreground">{p.cost}</span>
              </div>
              <p className="text-[12px] leading-relaxed text-muted-foreground">{p.when}</p>
              <CodeSnippet code={p.lines} className="mt-auto" />
            </div>
          ))}
        </div>
        <p className="px-2 pb-2 pt-1 text-[12px] leading-relaxed text-muted-foreground">
          Cost is relative. Compare live prices per model on <a className="underline underline-offset-4 hover:text-foreground" href="https://openrouter.ai/models" target="_blank" rel="noreferrer">openrouter.ai/models</a>.
          A Claude Pro or Max subscription cannot run these jobs (Anthropic only allows it inside its own apps), but your agent in Claude Code already uses it when it talks to OpenNous.
        </p>
      </SettingsGroup>

      <SettingsGroup title="Integrations" action={<GuideLink href={`${setup.guide}#integrations`} />}>
        {setup.integrations.map((i) => (
          <SettingsRow key={i.id} label={i.name} hint={i.kind}
            leading={<img src={`/provider-logos/${i.id === "gmail_oauth" ? "gmail" : i.id}.svg`} alt="" className="h-5 w-5 object-contain" />}>
            {i.ready
              ? <Status ok>Ready</Status>
              : <><Env names={i.needs} />{i.guide && <GuideLink href={i.guide}>How</GuideLink>}</>}
          </SettingsRow>
        ))}
        <p className="px-2 pb-2 pt-1 text-[12px] leading-relaxed text-muted-foreground">
          Ready ones connect from <Link to="/integrations" className="underline underline-offset-4 hover:text-foreground">Integrations</Link>: each person pastes a key from that tool.
        </p>
      </SettingsGroup>

      <SettingsGroup title="Email" action={<GuideLink href={setup.email.guide} />}>
        <SettingsRow label="Sign-in emails" hint="Password reset and email confirmation need SMTP.">
          {setup.email.ready ? <Status ok>SMTP set</Status> : <><Status ok={false}>Off</Status><Env names={["SMTP_HOST", "SMTP_ADMIN_EMAIL"]} /></>}
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Your agent">
        <SettingsRow label="Connect your agent" hint="Claude Code, Codex or any MCP client, with an API key.">
          {setup.agent.connected
            ? <Status ok>Connected</Status>
            : <Link to="/keys" className="inline-flex h-7 items-center rounded-lg border border-border bg-card px-2.5 text-[12.5px] font-medium text-foreground hover:bg-hover">Create a key</Link>}
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
