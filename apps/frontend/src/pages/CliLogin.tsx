import { useState, useEffect } from "react";
import { useSearchParams, useLocation, useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import GraphField from "@/components/GraphField";
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
  const { session, userData, loading } = useAuth();
  const workspaceId = (userData as { workspace?: { id?: string } })?.workspace?.id;
  const workspaceName = (userData as { workspace?: { name?: string } })?.workspace?.name;

  // Bring them back to THIS url — code and all — after they authenticate.
  const returnTo = `${location.pathname}${location.search}`;

  const [state, setState] = useState<"idle" | "approving" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(3);

  const signedIn = !!session?.access_token;

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
    if (!session?.access_token || !workspaceId) {
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
        throw new Error(j.error === "expired" ? "This sign-in expired. Run the command again." : "Couldn't authorize. Run the command again.");
      }
      setState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setState("error");
    }
  };

  return (
    <div
      className="relative overflow-hidden min-h-screen flex items-center justify-center px-4 font-geist-mono text-[#1A1712]"
      style={PAGE_STYLE}
    >
      <GraphField />
      <div
        className="relative z-10 w-full max-w-[400px] overflow-hidden rounded-lg border border-[#E4DED1] bg-[#FBFAF5]"
        style={BOX_SHADOW}
      >
        {/* title bar */}
        <div className="flex items-center gap-2 border-b border-[#E4DED1] px-4 py-2 text-xs text-[#6B655B]">
          <span className="text-[#96601f]/80">●</span>
          <span className="text-[#E0912B]/80">●</span>
          <span className="text-[#96601f]/60">●</span>
          <span className="ml-1">nous — connect cli</span>
        </div>

        <div className="p-6 text-center">
          <div className="flex items-center justify-center gap-2">
            <img src="/Nous.png" alt="" className="w-5 h-5 object-contain" />
            <span className="font-fraunces font-semibold text-[16px] tracking-[-0.01em] text-[#1A1712]">nous</span>
          </div>

          {!code ? (
            <>
              <h1 className="mt-4 font-fraunces text-[26px] font-semibold tracking-[-0.02em] text-[#1A1712]">
                Missing sign-in code
              </h1>
              <p className="mt-1 text-xs text-[#6B655B]">
                Start from your terminal with the Nous login command.
              </p>
            </>
          ) : loading ? (
            <>
              <h1 className="mt-4 font-fraunces text-[26px] font-semibold tracking-[-0.02em] text-[#1A1712]">
                One moment
              </h1>
              <p className="mt-1 text-xs text-[#6B655B]">Checking your session…</p>
            </>
          ) : !signedIn ? (
            <>
              <h1 className="mt-4 font-fraunces text-[26px] font-semibold tracking-[-0.02em] text-[#1A1712]">
                Create your account
              </h1>
              <p className="mt-1 text-xs text-[#6B655B] leading-relaxed">
                We&apos;ll take you right back to your terminal to finish connecting.
              </p>
              <Link
                to={authPathWithRedirect("/signup", returnTo)}
                className="mt-5 w-full h-12 rounded-lg pl-5 pr-1.5 flex items-center justify-between gap-2 font-medium text-sm bg-[#E0912B] hover:brightness-105 text-[#1a1000] transition-transform hover:scale-[1.005]"
              >
                <span>Create account</span>
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-[#1a1000] text-[#E0912B]" aria-hidden="true">→</span>
              </Link>
              <p className="mt-3 text-[11.5px] text-[#6B655B]/80">
                Already have an account?{" "}
                <Link to={authPathWithRedirect("/login", returnTo)} className="font-semibold text-[#1A1712] hover:text-[#96601f]">
                  Sign in
                </Link>
              </p>
            </>
          ) : state === "done" ? (
            <>
              <div className="mx-auto mt-4 mb-3 grid h-10 w-10 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 text-[20px]">
                ✓
              </div>
              <h1 className="font-fraunces text-[26px] font-semibold tracking-[-0.02em] text-[#1A1712]">
                You&apos;re connected
              </h1>
              <p className="mt-1 text-xs text-[#6B655B]">
                Go back to your terminal — your agent is ready to set up Nous.
              </p>
              <p className="mt-3 text-[11.5px] text-[#6B655B]/80">
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
              <h1 className="mt-4 font-fraunces text-[26px] font-semibold tracking-[-0.02em] text-[#1A1712]">
                Connect Nous to your agent
              </h1>
              <p className="mt-1 text-xs text-[#6B655B] leading-relaxed">
                Approve to create an API key for{" "}
                <span className="font-semibold text-[#1A1712]">{workspaceName || "your workspace"}</span>{" "}
                and finish signing in from the terminal.
              </p>
              {error && <p className="mt-3 text-[12.5px] text-[#96601f]">{error}</p>}
              <button
                onClick={approve}
                // A brand-new signup lands here the instant the session exists, which can be
                // a beat before /api/me has provisioned their workspace. Wait for the id
                // rather than letting Approve fire and error.
                disabled={state === "approving" || !workspaceId}
                className="mt-5 w-full h-12 rounded-lg pl-5 pr-1.5 flex items-center justify-between gap-2 font-medium text-sm bg-[#E0912B] hover:brightness-105 text-[#1a1000] transition-transform hover:scale-[1.005] disabled:opacity-60 disabled:hover:scale-100"
              >
                <span>{state === "approving" ? "Authorizing…" : !workspaceId ? "Preparing your workspace…" : "Approve"}</span>
                <span
                  className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-[#1a1000] text-[#E0912B]"
                  aria-hidden="true"
                >
                  →
                </span>
              </button>
              <p className="mt-3 text-[11.5px] text-[#6B655B]/80">
                Only approve if you just ran the Nous login command yourself.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
