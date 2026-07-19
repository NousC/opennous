import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, CheckCircle2, Loader2, ArrowLeft } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { invalidateOnboarding } from "@/hooks/useOnboarding";
import { installCommand } from "@/lib/install";

const API_URL = import.meta.env.VITE_API_URL ?? "";

/**
 * First-run setup.
 *
 * Setup has exactly ONE job: give the workspace an ICP. Everything downstream —
 * scoring, attention, the briefs — reads it, and nothing works properly without it.
 * So that is the finish line, and there are two roads to it depending on who just
 * signed up:
 *
 *   They have a coding agent → point it at Nous and say the word. The agent looks
 *   for an ICP file already in their repo, syncs it, and if there isn't one it
 *   drafts one from their website and WRITES it into their project. The artifact
 *   ends up where the rest of their GTM context already lives.
 *
 *   They don't → they answer the same question in the app. We read their website,
 *   draft the ICP, they edit it. No terminal, no agent, no CLI.
 *
 * The old version of this screen only had the first road. Which meant a
 * non-technical signup had no coding agent AND no in-app agent (that's Custom),
 * hit "Skip for now", and landed in an empty app with nothing to do. That wasn't an
 * onboarding gap, it was a dead end.
 */


// The context layer, not just the ICP.
//
// Setup used to fetch one file (the ICP). But the thing that actually took people forever
// wasn't writing an ICP — it was figuring out the STRUCTURE: where GTM context should live
// and what belongs in it. So the agent's job here is to stand up the whole load-bearing set
// (icp, positioning, voice, messaging) as ./context/*.md, and Nous mirrors it. The repo is
// the vault, Nous is the lens over the context/ subset. See internal/ONBOARDING.md §5.
//
// Two rules keep it safe:
//   RECONCILE, don't create. Plenty of these users already have this written down — those
//   files ARE the context, and drafting a second one next to them is the worst thing we can
//   do. Look first, sync what's there untouched, draft only what's genuinely missing.
//   AUDIT-FIRST, scaffold on consent. It shows the plan before it creates any folders — we
//   don't dump a structure into someone's existing repo without asking.
//
// The gate is still just hasIcp: a user who ends up with only icp.md still onboards. The
// other three docs are upside, not a new requirement — we widen the invitation, not the bar.
// raw/ and wiki/ are recommended but never built or synced here (context-only for now).
const ONBOARD_PROMPT =
  "Set up my revenue context layer and sync it to Nous.\n\n" +
  "First look through my repo (context/, .claude/, docs/, CLAUDE.md) for anything about who we sell to (ICP), how we position, our pricing, and our competitors. Tell me what you found and where.\n\n" +
  "Then get it into context/icp.md, context/positioning.md, context/pricing.md, and context/competitors.md. Keep what's already good as it is, don't rewrite it. For anything missing, ask me for my website, research it, draft it, show me, and once I approve, save it and sync it to Nous.\n\n" +
  "Show me the plan before you create any files.";

type Step = { caption: string; code: string };

function Cmd({ caption, code }: Step) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div>
      <div className="text-[11px] text-muted-foreground/70 mb-1">{caption}</div>
      <button
        onClick={copy}
        title="Copy"
        className="group flex w-full items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-left hover:border-border/80 transition-colors"
      >
        <pre className="m-0 flex-1 overflow-x-auto whitespace-pre text-[13px] font-mono text-foreground/90">{code}</pre>
        {copied
          ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
          : <Copy className="h-3.5 w-3.5 text-muted-foreground/60 group-hover:text-foreground/70 flex-shrink-0 mt-0.5" />}
      </button>
    </div>
  );
}

export default function ConnectGate() {
  const { session, userData, refreshUserData, signOut } = useAuth();
  const navigate = useNavigate();
  const token = session?.access_token;
  const workspaceId = (userData as { workspace?: { id?: string } })?.workspace?.id;
  const email = (userData as { user?: { email?: string } })?.user?.email;
  const selfHosted = (userData as { self_hosted?: boolean })?.self_hosted === true;

  const [road, setRoad] = useState<null | "agent" | "app">(null);
  const [celebrating, setCelebrating] = useState(false);

  // Self-host: the login and the MCP must point at THIS instance, not Nous Cloud.
  const apiBase = API_URL || (selfHosted ? window.location.origin : "");

  // First-run activation: welcome email, free-plan backstop, dogfood. Idempotent.
  useEffect(() => {
    if (!token) return;
    fetch(`${API_URL}/api/onboarding/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
  }, [token]);

  // Poll for the agent road. When the user's agent sets the ICP from the terminal, we
  // detect it here and celebrate. The APP road drives its own completion (it has a source
  // step after the ICP), so we don't auto-whisk it away the instant the ICP saves — that
  // would skip connecting Gmail and drop them into an empty graph.
  useEffect(() => {
    if (!token || !workspaceId || road === "app") return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await fetch(`${API_URL}/api/onboarding/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const d = await r.json();
        if (!stopped && d.onboarded) setCelebrating(true);
      } catch { /* keep polling */ }
    };
    tick();
    const iv = setInterval(tick, 4000);
    return () => { stopped = true; clearInterval(iv); };
  }, [token, workspaceId, road]);

  useEffect(() => {
    if (!celebrating) return;
    // Tell the router to ask again. It caches the onboarding answer, and the answer it has
    // is the `false` it fetched when this screen mounted — navigate without dropping that
    // and AppRoutes reads the stale value and renders this screen straight back at them.
    invalidateOnboarding();
    refreshUserData();
    const t = setTimeout(() => navigate("/accounts", { replace: true }), 1800);
    return () => clearTimeout(t);
  }, [celebrating, refreshUserData, navigate]);

  const skip = () => {
    try { if (workspaceId) localStorage.setItem(`nous_connect_skipped:${workspaceId}`, "1"); } catch { /* ignore */ }
    navigate("/accounts", { replace: true });
  };

  if (celebrating) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background animate-in fade-in duration-300">
        <div className="flex flex-col items-center text-center">
          <div className="relative grid h-16 w-16 place-items-center">
            <span className="absolute h-16 w-16 rounded-full bg-emerald-500/20 animate-ping" />
            <span className="relative grid h-16 w-16 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 animate-in zoom-in duration-500">
              <CheckCircle2 className="h-9 w-9" />
            </span>
          </div>
          <div className="mt-5 text-[19px] font-semibold tracking-tight text-foreground animate-in fade-in slide-in-from-bottom-1 duration-500">
            You're all set
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground">Opening your workspace…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-[600px]">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <img src="/nous-logo.svg" alt="" className="w-5 h-5 object-contain" />
            <span className="font-bold text-[14px] tracking-[-0.02em] text-foreground">nous</span>
          </div>
          {email && (
            <button onClick={() => signOut?.()} className="text-[12px] text-muted-foreground/70 hover:text-foreground transition-colors">
              {email} · sign out
            </button>
          )}
        </div>

        <div className="rounded-2xl border border-border/60 bg-background shadow-sm p-6 sm:p-8">
          {road === null && <Fork onPick={setRoad} />}
          {road === "agent" && <AgentRoad onBack={() => setRoad(null)} />}
          {road === "app" && (
            <AppRoad
              token={token}
              apiBase={apiBase}
              workspaceId={workspaceId}
              onBack={() => setRoad(null)}
              onDone={() => setCelebrating(true)}
            />
          )}

          <div className="mt-6 flex items-center justify-between gap-3 border-t border-border/60 pt-4">
            <p className="text-[11.5px] text-muted-foreground/60">
              Stuck? See the <a href="https://docs.opennous.cloud/mcp/introduction" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">docs</a>.
            </p>
            <button onClick={skip} className="text-[11.5px] text-muted-foreground/60 hover:text-foreground transition-colors whitespace-nowrap">
              Skip for now →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The fork ────────────────────────────────────────────────────────────────
//
// Not "how technical are you?" — nobody enjoys answering that, and it's not what
// we need to know. What we need to know is whether they already have an agent,
// because that decides which of two genuinely different setups they get.

/**
 * The agents we work with, overlapped like a face pile — the shorthand every product
 * uses for "these people, and more of them".
 *
 * Real logos in their own colours on white chips, so they read as the actual products
 * rather than as decoration. They sit in the corner of the card and answer the question
 * the heading is asking, which is why the card needs no icon of its own: an abstract
 * terminal glyph tells you nothing you didn't already know, and these tell you whether
 * this row is about you.
 */
const AGENTS = [
  { src: "/provider-logos/claude.svg", alt: "Claude Code" },
  { src: "/provider-logos/codex.png",  alt: "Codex" },
  { src: "/provider-logos/cursor.svg", alt: "Cursor" },
  { src: "/provider-logos/gemini.svg", alt: "Gemini CLI" },
];

function AgentLogos() {
  return (
    <div className="absolute top-4 right-4 flex items-center">
      {AGENTS.map(a => (
        <span
          key={a.alt}
          title={a.alt}
          // Overlap, and reverse the stacking so the leftmost sits on top — a pile reads
          // left to right, so the one in front should be the one you meet first.
          className="relative -ml-2 first:ml-0 grid h-7 w-7 place-items-center rounded-full
                     bg-white ring-1 ring-border shadow-sm
                     [&:nth-child(1)]:z-40 [&:nth-child(2)]:z-30 [&:nth-child(3)]:z-20 [&:nth-child(4)]:z-10"
        >
          <img src={a.src} alt={a.alt} className="h-3.5 w-3.5 object-contain" />
        </span>
      ))}
    </div>
  );
}

function Fork({ onPick }: { onPick: (r: "agent" | "app") => void }) {
  return (
    <>
      <h1 className="text-[19px] font-semibold tracking-tight text-foreground">Let's set up your workspace</h1>
      <p className="text-[13px] text-muted-foreground mt-1.5 leading-relaxed">
        One thing to do: tell Nous who you sell to. Everything else — scoring, what needs
        attention, the account briefs — reads it.
      </p>

      <div className="mt-6 grid gap-3">
        <button
          onClick={() => onPick("agent")}
          className="group relative text-left rounded-xl border border-border bg-muted/30 p-4 hover:border-foreground/25 hover:bg-muted/50 transition-all"
        >
          {/* The logos ARE the label. "I work in a coding agent" is a question about a
              product you either recognise or you don't, and four marks you know beats any
              sentence describing them. */}
          <AgentLogos />
          <span className="text-[14px] font-medium text-foreground">I work in a coding agent</span>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground leading-relaxed">
            Connect it and your agent does the setup — it audits the GTM context already in
            your project, fills in what's missing, and syncs it to Nous.
          </p>
        </button>

        <button
          onClick={() => onPick("app")}
          className="group text-left rounded-xl border border-border bg-muted/30 p-4 hover:border-foreground/25 hover:bg-muted/50 transition-all"
        >
          <span className="text-[14px] font-medium text-foreground">Set it up here</span>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground leading-relaxed">
            Give us your website and we'll draft your ICP for you. No terminal, nothing to
            install. Takes a minute.
          </p>
        </button>
      </div>
    </>
  );
}

// ── Road 1: the agent does it ───────────────────────────────────────────────

// Deliberately minimal. If they got here via `nous init`, the MCP is already connected —
// they just need the prompt, then they go back to their agent and say the word. If they
// haven't connected yet, the docs are the one place that setup lives; don't duplicate the
// .mcp.json config in-app. Either way: paste the prompt, this screen unlocks when the ICP
// lands (the parent polls for it — the gate is still hasIcp even though the agent sets up
// the wider context/ set).
function AgentRoad({ onBack }: { onBack: () => void }) {
  return (
    <>
      <button onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground/70 hover:text-foreground transition-colors">
        <ArrowLeft className="h-3 w-3" /> Back
      </button>

      <h1 className="text-[19px] font-semibold tracking-tight text-foreground">Connect your agent</h1>

      <div className="mt-5">
        <Cmd caption="Paste this into your coding agent to get started" code={ONBOARD_PROMPT} />
      </div>

      <p className="mt-4 text-[12px] text-muted-foreground/80 leading-relaxed">
        Haven't connected Nous to your agent yet?{" "}
        <a
          href="https://docs.opennous.cloud/mcp/introduction"
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-2 hover:text-foreground/80"
        >
          Set up the MCP server →
        </a>
      </p>
    </>
  );
}

// ── Road 2: they do it here ─────────────────────────────────────────────────
//
// The whole point: a non-technical signup has no coding agent AND no in-app agent
// (Threads is Custom). Without this road they cannot set the product up at all.

function AppRoad({ token, apiBase, workspaceId, onBack, onDone }: {
  token?: string;
  apiBase: string;
  workspaceId?: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [website, setWebsite] = useState("");
  const [icp, setIcp] = useState("");
  // ask (website) → review (edit the ICP) → connect (a source, then finish). The ICP is the
  // finish line for the GATE, but a workspace with an ICP and no source never fills in, so
  // the flow doesn't end until we've offered to connect one.
  const [phase, setPhase] = useState<"ask" | "review" | "connect">("ask");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const draft = async () => {
    if (!website.trim() || !token) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${API_URL}/api/onboarding/icp/draft`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ website: website.trim() }),
      });
      const d = await r.json();
      if (!r.ok) {
        // Couldn't read the site. Don't dead-end them — open the editor empty and
        // let them write it. A blank box they can fill beats an error they can't.
        setErr(d?.message || "Couldn't read that site.");
        setPhase("review");
        return;
      }
      setIcp(d.draft ?? "");
      setPhase("review");
    } catch {
      setErr("Something went wrong reading that site. Write it yourself and we'll take it from there.");
      setPhase("review");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (icp.trim().length < 20 || !token) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${API_URL}/api/onboarding/icp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ icp_text: icp.trim() }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setErr(d?.error === "icp_too_short" ? "A little more detail — a sentence or two." : "Couldn't save that.");
        return;
      }
      // ICP saved — the gate is open. Move to the source step rather than leaving; the
      // parent no longer auto-navigates the app road for exactly this reason.
      setPhase("connect");
    } catch {
      setErr("Couldn't save that.");
    } finally {
      setBusy(false);
    }
  };

  // Gmail + Calendar in one grant. Opens the Google authorize flow in this tab; on return
  // the callback lands us back in the app. We connect a source but never block on it — the
  // ICP already opened the gate.
  const connectGoogle = () => {
    if (!workspaceId) return;
    const name = encodeURIComponent("Gmail");
    window.location.href = `${apiBase}/api/oauth/google/gmail/authorize?workspaceId=${workspaceId}&connectionName=${name}`;
  };

  return (
    <>
      {phase !== "connect" && (
        <button
          onClick={() => (phase === "review" ? setPhase("ask") : onBack())}
          className="mb-3 inline-flex items-center gap-1 text-[12px] text-muted-foreground/70 hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3 w-3" /> Back
        </button>
      )}

      {phase === "connect" ? (
        <>
          <div className="flex items-center gap-2">
            <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500/10 text-emerald-600">
              <CheckCircle2 className="h-3.5 w-3.5" />
            </span>
            <span className="text-[12.5px] font-medium text-emerald-600">ICP saved</span>
          </div>
          <h1 className="mt-3 text-[19px] font-semibold tracking-tight text-foreground">One more thing: connect Gmail</h1>
          <p className="text-[13px] text-muted-foreground mt-1.5 leading-relaxed">
            Your ICP is set, but the graph is still empty. Connect Gmail and your calendar and
            it starts filling itself in from the conversations you're already having. This is
            the difference between a workspace that works and one that just sits there.
          </p>

          <button
            onClick={connectGoogle}
            disabled={!workspaceId}
            className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-[13.5px] font-medium text-background disabled:opacity-40 transition-opacity"
          >
            <img src="/provider-logos/gemini.svg" alt="" className="h-4 w-4" />
            Connect Gmail &amp; Calendar
          </button>

          <button
            onClick={onDone}
            className="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-border px-4 py-2.5 text-[13px] font-medium text-muted-foreground hover:text-foreground hover:border-foreground/25 transition-colors"
          >
            Skip — open my workspace
          </button>

          {/* Even here, the agent is the best way to finish setup (it builds the Vault from
              your repo). So we hand the terminal command to Google users too. */}
          <div className="mt-4 rounded-lg border border-border/60 bg-muted/30 p-3">
            <p className="text-[11.5px] font-medium text-foreground">Work in a coding agent? Connect it for the full setup.</p>
            <div className="mt-2 flex items-stretch gap-2">
              <code className="flex-1 min-w-0 rounded-md border border-border bg-background px-2.5 py-1.5 text-[11.5px] text-foreground font-mono overflow-x-auto whitespace-nowrap">
                {installCommand()}
              </code>
              <button
                onClick={() => { navigator.clipboard?.writeText(installCommand()); }}
                title="Copy"
                className="flex-shrink-0 grid place-items-center w-9 rounded-md border border-border bg-background hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <p className="mt-3 text-[11.5px] text-muted-foreground/60 leading-relaxed">
            You can connect Gmail, meeting tools, Slack and more anytime from Integrations.
          </p>
        </>
      ) : phase === "ask" ? (
        <>
          <h1 className="text-[19px] font-semibold tracking-tight text-foreground">Who do you sell to?</h1>
          <p className="text-[13px] text-muted-foreground mt-1.5 leading-relaxed">
            Give us your website and we'll read it and write the first draft. You'll get to
            edit it before anything is saved.
          </p>

          <div className="mt-5 flex gap-2">
            <input
              autoFocus
              value={website}
              onChange={e => setWebsite(e.target.value)}
              onKeyDown={e => e.key === "Enter" && draft()}
              placeholder="acme.com"
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-foreground/30 transition-colors"
            />
            <button
              onClick={draft}
              disabled={!website.trim() || busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-4 py-2.5 text-[13px] font-medium text-background disabled:opacity-40 transition-opacity"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {busy ? "Reading…" : "Draft it"}
            </button>
          </div>

          <button
            onClick={() => { setIcp(""); setPhase("review"); }}
            className="mt-3 text-[12px] text-muted-foreground/70 hover:text-foreground transition-colors"
          >
            I'd rather just write it myself →
          </button>
        </>
      ) : (
        <>
          <h1 className="text-[19px] font-semibold tracking-tight text-foreground">Does this look right?</h1>
          <p className="text-[13px] text-muted-foreground mt-1.5 leading-relaxed">
            Edit anything. This is what scores every account you'll ever touch, so it's worth
            thirty seconds. You can change it later on the ICP page.
          </p>

          {err && (
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12.5px] text-amber-700 dark:text-amber-500">
              {err}
            </div>
          )}

          <textarea
            autoFocus
            value={icp}
            onChange={e => setIcp(e.target.value)}
            rows={7}
            placeholder="Seed to Series B B2B SaaS companies doing outbound with a 2-5 person sales team. The buyer is usually the founder or a head of sales. They come to us when their CRM has gone stale and nobody trusts the pipeline."
            className="mt-4 w-full resize-none rounded-lg border border-border bg-background px-3 py-2.5 text-[13.5px] leading-relaxed text-foreground placeholder:text-muted-foreground/40 outline-none focus:border-foreground/30 transition-colors"
          />

          <button
            onClick={save}
            disabled={icp.trim().length < 20 || busy}
            className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-foreground px-4 py-2.5 text-[13.5px] font-medium text-background disabled:opacity-40 transition-opacity"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save and continue
          </button>

          <p className="mt-3 text-[11.5px] text-muted-foreground/60 leading-relaxed">
            Next: connect Gmail or your calendar and the graph starts filling itself in.
          </p>
        </>
      )}
    </>
  );
}
