import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SignUp } from "@clerk/react";
import { Copy, Check } from "lucide-react";
import GraphField from "@/components/GraphField";
import { PAGE_STYLE, CLERK_APPEARANCE } from "@/lib/authTheme";
import { safeRedirect } from "@/lib/authRedirect";
import { installCommand } from "@/lib/install";
import { useAuthConfig } from "@/lib/authConfig";

// Signup keeps the agent-first hero (the whole "operate Nous with your coding
// agent" pitch) but hands the actual account creation — email, Google, email
// code, the "Secured by Clerk" badge — to Clerk's <SignUp>, so it matches the
// login page and we don't hand-roll auth.
const SignupContent = () => {
  // The default assumption is that you have a coding agent — Nous is built to be operated
  // by one, and that's the best way to set up your Vault. So the agent path is the hero:
  // run the one-liner, or paste a prompt into Claude Code / Cursor.
  const [agentMethod, setAgentMethod] = useState<"terminal" | "agent">("terminal");
  const [copied, setCopied] = useState(false);
  const { signupsDisabled } = useAuthConfig();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // The CLI flow sends new users here with ?redirect=/cli-login?code=… so the terminal
  // can finish after they create an account. With no such param, land on "/" — the
  // first-run gate (ConnectGate) takes it from there. See lib/authRedirect.
  const redirectParam = safeRedirect(searchParams.get("redirect"));
  const afterAuth = redirectParam;
  const redirectQuery = searchParams.get("redirect")
    ? `?redirect=${encodeURIComponent(searchParams.get("redirect")!)}`
    : "";
  // Reached from the CLI device-login (`npx @opennous/cli init` → /cli-login → "Create
  // account"). These users ALREADY ran the terminal command, so leading with the
  // "Run in terminal" hero tells them to do the thing they just did — and sends them
  // right back to this page in a loop. In this flow, hide the hero.
  const fromCli = redirectParam.startsWith("/cli-login");

  // One command. It installs the CLI, signs you in (creating your account), registers the
  // MCP with your agent, and hands off — the agent does the real setup, Vault and all.
  const TERMINAL_CMD = installCommand();
  const AGENT_PROMPT =
    "Set up Nous in this project. Run `npx @opennous/cli init` to install the CLI and connect it, then find my ICP (context/icp.md, or an ICP section in CLAUDE.md) and sync it to Nous — or, if there isn't one, ask for my website, draft an ICP, write it to ./context/icp.md, and sync that.";
  const copyAgent = () => {
    const text = agentMethod === "terminal" ? TERMINAL_CMD : AGENT_PROMPT;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {});
  };

  // Self-host: if registration is closed, there is no signup — send to login.
  useEffect(() => {
    if (signupsDisabled) navigate("/login", { replace: true });
  }, [signupsDisabled, navigate]);

  // Capture affiliate referral code from URL and persist in localStorage
  useEffect(() => {
    const ref = searchParams.get("ref") || searchParams.get("affiliate");
    if (ref) localStorage.setItem("nous_affiliate_ref", ref.toUpperCase());
  }, [searchParams]);

  return (
    <div
      className="relative overflow-hidden min-h-screen flex items-center justify-center px-4 py-10 font-geist-mono text-[#1A1712]"
      style={PAGE_STYLE}
    >
      <GraphField />
      <div className="relative z-10 w-full max-w-[400px] flex flex-col items-center gap-4">
        {/* Brand mark */}
        <div className="flex items-center gap-2">
          <img src="/nous-logo.svg" alt="" className="w-5 h-5 object-contain" />
          <span className="font-fraunces font-semibold text-[16px] tracking-[-0.01em] text-[#1A1712]">nous</span>
        </div>

        {/* Agent-first hero — HIDDEN in the CLI flow (they already ran the command). */}
        {!fromCli && (
          <div className="w-full rounded-xl border border-[#E7E1D4] bg-[#F7F3EA] p-4">
            <div className="flex items-center gap-2 text-[12px] font-semibold tracking-[-0.01em] text-[#1A1712]">
              <span className="font-geist-mono text-[#B87413]">&gt;_</span>
              Connect your coding agent
            </div>

            {/* toggle: terminal command vs a prompt to paste into the agent */}
            <div className="mt-3 flex items-center gap-4 text-[11.5px]">
              {(["terminal", "agent"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setAgentMethod(m)}
                  className={`pb-0.5 transition-colors ${agentMethod === m
                    ? "text-[#1A1712] font-medium border-b border-[#1A1712]"
                    : "text-[#8A8478] hover:text-[#1A1712]"}`}
                >
                  {m === "terminal" ? "Run in terminal" : "Paste to your agent"}
                </button>
              ))}
            </div>

            {/* command box — copy button reveals on hover only */}
            <div className="group/cmd relative mt-2.5 rounded-lg border border-[#E7E1D4] bg-[#FCFBF7] px-3 py-2.5">
              <code className="block pr-7 text-[11.5px] leading-relaxed text-[#2A251E] font-geist-mono whitespace-pre-wrap break-words">
                {agentMethod === "terminal" ? TERMINAL_CMD : AGENT_PROMPT}
              </code>
              <button
                type="button"
                onClick={copyAgent}
                title="Copy"
                className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md text-[#8A8478] opacity-0 group-hover/cmd:opacity-100 hover:bg-[#EFEBE2] hover:text-[#1A1712] transition-all"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>

            <p className="mt-3 text-center text-[10px] uppercase tracking-[0.14em] text-[#8A8478]">
              or set it up here
            </p>
          </div>
        )}

        {/* Clerk account creation — Google, email + email code, Secured-by-Clerk badge. */}
        <SignUp
          routing="virtual"
          signInUrl={`/login${redirectQuery}`}
          forceRedirectUrl={afterAuth}
          appearance={CLERK_APPEARANCE}
        />
      </div>
    </div>
  );
};

const Signup = () => <SignupContent />;

export default Signup;
