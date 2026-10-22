import { useMemo, useState } from "react";
import { Check, Copy, Terminal, Sparkles, Code } from "lucide-react";

// ── Install scripts, agent prompts, and inline snippets ─────────────────────
// These are the three things shippable today. The CLI flow is the most polished
// for humans, the agent prompt is the most polished for AI assistants, and the
// raw curl is the escape hatch.

const CLI_SNIPPET = `# in your project root
npx -y @opennous/cli@latest install`;

const AGENT_PROMPT = `Wire Nous event tracking into this project.

What Nous needs:
- After a user signs up: POST one observation tagged interaction.signed_up
- After a Stripe customer.subscription event: POST observations tagged
  interaction.subscription_started / interaction.subscription_updated
  / interaction.subscription_canceled
- All POSTs go to: https://api.opennous.cloud/v2/observations
  with header: Authorization: Bearer \${process.env.NOUS_API_KEY}
- Body: { "focus": "<email>",
          "observations": [{ "kind":"event"|"state", "property":"...", "value":{...} }] }

What to do:
1. Add NOUS_API_KEY to .env (the user will fill the value).
2. Detect the framework (Next.js, Express, Fastify, FastAPI, Django, Rails, ...).
3. Find the signup handler. Right after the new account row is persisted, call
   the Nous endpoint with focus=<user email>, event=interaction.signed_up,
   value={ plan:"free", source:<your domain>, at:<ISO timestamp> }, plus a
   state observation { property:"stage", value:"Free User" }.
4. Find or create the Stripe webhook handler. For customer.subscription.created
   or .updated (status=active), call /v2/observations with focus=<user email>,
   event=interaction.subscription_started (or _updated), state stage=Customer.
   For customer.subscription.deleted: event=interaction.subscription_canceled,
   state stage=Churned.
5. Wrap every call in try/catch so it never blocks the parent request. Log
   failures with prefix [NOUS].
6. Print a checklist of what you changed and what env vars the user must set.

Style: native to the language and framework. Match existing conventions in
this codebase. No new dependencies unless strictly necessary — fetch is fine.`;

const CURL_SNIPPET = `curl -X POST https://api.opennous.cloud/v2/observations \\
  -H 'Authorization: Bearer YOUR_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "focus": "new-user@example.com",
    "observations": [
      { "kind":"event", "property":"interaction.signed_up",
        "value": { "plan":"free", "source":"yourapp.com" } },
      { "kind":"state", "property":"stage", "value":"Free User" }
    ]
  }'`;

type Tab = "cli" | "agent" | "curl";

const TABS: { id: Tab; label: string; Icon: typeof Terminal }[] = [
  { id: "cli",   label: "CLI",         Icon: Terminal  },
  { id: "agent", label: "AI prompt",   Icon: Sparkles  },
  { id: "curl",  label: "Raw curl",    Icon: Code      },
];

/**
 * Tabbed install panel — tabs + code block, no card chrome.
 * Used inside the Add-integration → Nous → Connect modal.
 */
export function NousInstallTabs() {
  const [tab, setTab] = useState<Tab>("cli");
  const [copied, setCopied] = useState(false);

  const payload = useMemo(() => {
    if (tab === "cli")   return CLI_SNIPPET;
    if (tab === "agent") return AGENT_PROMPT;
    return CURL_SNIPPET;
  }, [tab]);

  const copy = () => {
    navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">
        Pipe your own signups and Stripe lifecycle events into Nous. Every new user
        becomes a person in your workspace and their subscription state stays in sync.
      </p>

      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={
              "flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium border-b-2 -mb-px transition-colors " +
              (tab === id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground/80")
            }
          >
            <Icon className="h-3 w-3" />
            {label}
          </button>
        ))}
      </div>

      {/* Code block */}
      <div className="rounded-lg bg-zinc-950 border border-zinc-800 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500 font-mono">
            {tab === "cli" ? "shell" : tab === "agent" ? "prompt" : "curl"}
          </span>
          <button
            onClick={copy}
            className={
              "flex items-center gap-1 text-[11px] px-2 py-1 rounded transition-colors " +
              (copied ? "text-emerald-400" : "text-zinc-400 hover:text-white hover:bg-zinc-800")
            }
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="text-[12px] font-mono text-zinc-200 p-3 overflow-x-auto leading-relaxed whitespace-pre-wrap break-words max-h-[320px]">
          <code>{payload}</code>
        </pre>
      </div>

      <p className="text-[12px] text-muted-foreground/80">
        The CLI writes a small <code className="px-1 py-0.5 rounded bg-muted text-foreground/80">nous.js</code> or{" "}
        <code className="px-1 py-0.5 rounded bg-muted text-foreground/80">nous.py</code> module and updates your{" "}
        <code className="px-1 py-0.5 rounded bg-muted text-foreground/80">.env</code>. You stay in control — read it, edit it, or delete it.
      </p>
    </div>
  );
}
