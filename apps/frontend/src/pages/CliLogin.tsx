import { useState, useEffect } from "react";
import { useSearchParams, useLocation, useNavigate, Link } from "react-router-dom";
import { Terminal, KeyRound, LogIn, ArrowRight } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PAGE_STYLE, BOX_SHADOW } from "@/lib/authTheme";
import { authPathWithRedirect } from "@/lib/authRedirect";

const API_URL = import.meta.env.VITE_API_URL ?? "";

// Browser approval page for the CLI device-login flow. The CLI opens
// /cli-login?code=<user_code>; the user approves, which mints an API key for their
// current workspace, and the CLI's next poll picks it up.
//
// This page is the account-creation step of "one command from zero". Someone runs the
// install command with NO Nous account, the CLI opens this URL, and if they aren't signed
// in we send them to sign up and bring them straight back here — code intact — so the
// terminal finishes. It used to just error ("Couldn't read your session"), which meant the
// terminal front door only worked for people who had already signed up on the web.
export default function CliLogin() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const code = params.get("code") || "";
  const { session, userData, loading, meError, refreshUserData } = useAuth();
  const workspaceId = (userData as { workspace?: { id?: string } })?.workspace?.id;
  const workspaceName = (userData as { workspace?: { name?: string } })?.workspace?.name;
  const userEmail = (userData as { user?: { email?: string } })?.user?.email;
  const userName = (userData as { user?: { name?: string } })?.user?.name;

  // Bring them back to THIS url — code and all — after they authenticate.
  const returnTo = `${location.pathname}${location.search}`;

  const [state, setState] = useState<"idle" | "approving" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(3);
  const [provisionTimedOut, setProvisionTimedOut] = useState(false);

  const signedIn = !!session?.access_token;
  // A closed self-host instance: the login exists but /me made no account for it
  // (403 signups_disabled), so there is no workspace to wait for. Only a CLI join token
  // can admit it, and approving is what redeems one, so let them approve. Never set on
  // Cloud, where this page behaves exactly as before.
  const joinOnly = signedIn && !workspaceId && meError === "signups_disabled";

  // Without this the Approve button sits disabled on "Preparing your workspace…" forever if
  // /api/me never provisions a workspace. Give provisioning ~15s, then surface a reload path
  // instead of a dead button.
  useEffect(() => {
    if (!signedIn || loading || workspaceId || joinOnly) { setProvisionTimedOut(false); return; }
    const t = setTimeout(() => setProvisionTimedOut(true), 15000);
    return () => clearTimeout(t);
  }, [signedIn, loading, workspaceId, joinOnly]);

  // Once the terminal is connected the user is signed in on the web too, but they're
  // stranded on this success page with no way into the product. Keep the "go back to your
  // terminal" confirmation, then whisk them into their workspace after a short countdown so
  // they don't have to go hunting for the sign-in. The router takes it from here — into
  // onboarding if the workspace isn't set up yet, into the app if it is.
  useEffect(() => {
    if (state !== "done") return;
    if (secondsLeft <= 0) {
      navigate("/", { replace: true });
      return;
    }
    const t = setTimeout(() => setSecondsLeft(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [state, secondsLeft, navigate]);

  const approve = async () => {
    if (!session?.access_token || (!workspaceId && !joinOnly)) {
      setError("Couldn't read your session. Reload and try again.");
      setState("error");
      return;
    }
    setState("approving");
    try {
      const r = await fetch(`${API_URL}/api/cli/auth/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: code, workspace_id: workspaceId }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (j.error === "expired") throw new Error("This sign-in expired. Run the command again.");
        if (joinOnly) {
          throw new Error(j.message || (j.error === "workspace_required"
            ? "This instance is invite-only. Ask its owner for a join link and run that command."
            : "Couldn't join. Run the command again."));
        }
        throw new Error("Couldn't authorize. Run the command again.");
      }
      setState("done");
      // The join just created their account: load it, so "/" opens the workspace.
      if (joinOnly) refreshUserData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setState("error");
    }
  };

  const primaryBtn =
    "w-full h-11 rounded-xl flex items-center justify-center gap-2 font-medium text-[13.5px] bg-[#E0912B] text-[#1a1000] transition-[filter,opacity] hover:brightness-105 disabled:opacity-60";

  return (
    <div
      className="relative min-h-screen flex items-center justify-center px-4 text-[#1A1712]"
      style={PAGE_STYLE}
    >
      <div
        className="relative z-10 w-full max-w-[400px] rounded-2xl border border-[#ECEAE4] bg-white p-7 text-center"
        style={BOX_SHADOW}
      >
        {/* Your agent → Nous */}
        <div className="flex items-center justify-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-full border border-[#ECEAE4] bg-[#FAF8F4] text-[#6B655B]">
            <Terminal className="h-[22px] w-[22px]" strokeWidth={1.6} />
          </div>
          <ArrowRight className="h-4 w-4 text-[#C9C4BA]" />
          <div className="grid h-12 w-12 place-items-center rounded-full bg-[#E0912B]/12">
            <img src="/nous-logo.svg" alt="" className="h-6 w-6 object-contain" />
          </div>
        </div>

        {!code ? (
          <>
            <h1 className="mt-5 text-[19px] font-semibold tracking-[-0.01em]">Missing sign-in code</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[#6B655B]">
              Start from your terminal — run <span className="font-mono text-[#1A1712]">/opennous:login</span>.
            </p>
          </>
        ) : loading ? (
          <>
            <h1 className="mt-5 text-[19px] font-semibold tracking-[-0.01em]">One moment</h1>
            <p className="mt-1.5 text-[13px] text-[#6B655B]">Checking your session…</p>
          </>
        ) : !signedIn ? (
          <>
            <h1 className="mt-5 text-[19px] font-semibold tracking-[-0.01em]">Create your Nous account</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[#6B655B]">
              We&apos;ll bring you right back here to finish connecting your agent.
            </p>
            <Link to={authPathWithRedirect("/signup", returnTo)} className={`mt-6 ${primaryBtn}`}>
              Create account <ArrowRight className="h-4 w-4" />
            </Link>
            <p className="mt-3.5 text-[12px] text-[#6B655B]/90">
              Already have an account?{" "}
              <Link to={authPathWithRedirect("/login", returnTo)} className="font-semibold text-[#1A1712] hover:text-[#96601f]">
                Sign in
              </Link>
            </p>
          </>
        ) : state === "done" ? (
          <>
            <h1 className="mt-5 text-[19px] font-semibold tracking-[-0.01em]">You&apos;re connected</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[#6B655B]">
              Head back to your terminal — your agent is signed in and ready.
            </p>
            <p className="mt-4 text-[12px] text-[#6B655B]/90">
              Opening your workspace in {secondsLeft}s…{" "}
              <button
                onClick={() => navigate("/", { replace: true })}
                className="font-semibold text-[#1A1712] hover:text-[#96601f] underline underline-offset-2"
              >
                Go now
              </button>
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-5 text-[19px] font-semibold tracking-[-0.01em]">Connect your agent to Nous</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[#6B655B]">
              Your coding agent is asking to sign in and work in your workspace.
            </p>

            {/* Account row */}
            <div className="mt-5 flex items-center gap-3 rounded-xl border border-[#ECEAE4] bg-[#FAF8F4] px-4 py-3 text-left">
              <div className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-[#E0912B]/15 text-[13px] font-semibold text-[#96601f]">
                {(userName || userEmail || session?.user?.email || "?").trim().charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                {userName && <div className="truncate text-[13px] font-medium text-[#1A1712]">{userName}</div>}
                <div className="truncate text-[12px] text-[#6B655B]">{userEmail || session?.user?.email || "your account"}</div>
              </div>
            </div>

            {/* What this grants */}
            <div className="mt-4 text-left">
              <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-[#6B655B]/70">This will</div>
              <ul className="space-y-2.5">
                <li className="flex items-start gap-2.5 text-[12.5px] text-[#3A352D]">
                  <KeyRound className="mt-[1px] h-4 w-4 flex-shrink-0 text-[#96601f]" strokeWidth={1.75} />
                  {joinOnly
                    ? <span>Join the team that invited you</span>
                    : <span>Create an API key scoped to <span className="font-semibold text-[#1A1712]">{workspaceName || "your workspace"}</span></span>}
                </li>
                <li className="flex items-start gap-2.5 text-[12.5px] text-[#3A352D]">
                  <LogIn className="mt-[1px] h-4 w-4 flex-shrink-0 text-[#96601f]" strokeWidth={1.75} />
                  <span>Sign you in from your terminal — no key to copy</span>
                </li>
              </ul>
            </div>

            {error && <p className="mt-4 text-[12.5px] text-[#96601f]">{error}</p>}
            {provisionTimedOut && !workspaceId && !joinOnly && !error && (
              <p className="mt-4 text-[12.5px] text-[#96601f]">
                This is taking longer than usual.{" "}
                <button onClick={() => window.location.reload()} className="font-semibold underline underline-offset-2 hover:text-[#1A1712]">
                  Reload
                </button>{" "}
                and try again.
              </p>
            )}

            <button
              onClick={approve}
              disabled={state === "approving" || (!workspaceId && !joinOnly)}
              className={`mt-5 ${primaryBtn} disabled:hover:brightness-100`}
            >
              {state === "approving" ? "Authorizing…" : !workspaceId && !joinOnly ? "Preparing your workspace…" : <>Approve <ArrowRight className="h-4 w-4" /></>}
            </button>
            <p className="mt-3.5 text-[11.5px] text-[#6B655B]/80">
              Only approve if you just ran the login command yourself.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
