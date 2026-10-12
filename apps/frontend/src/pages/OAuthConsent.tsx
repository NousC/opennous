import { useEffect, useState } from "react";
import { useSearchParams, useLocation, Link } from "react-router-dom";
import { ArrowRight, Eye, PenLine } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { PAGE_STYLE, BOX_SHADOW } from "@/lib/authTheme";
import { authPathWithRedirect } from "@/lib/authRedirect";

const API_URL = import.meta.env.VITE_API_URL ?? "";

// Consent screen for MCP OAuth (GET-762). Grok, Claude.ai, ChatGPT and other MCP
// clients send the user here from /oauth/authorize?...; approving mints a grant for
// the current workspace and sends the browser back to the client with a code.
//
// Public route, like /cli-login: a visitor without an account signs up and comes
// straight back here with the request intact.
export default function OAuthConsent() {
  const [params] = useSearchParams();
  const location = useLocation();
  const requestId = params.get("request") || "";
  const { session, userData, loading } = useAuth();
  const workspaceId = (userData as { workspace?: { id?: string } })?.workspace?.id;
  const workspaceName = (userData as { workspace?: { name?: string } })?.workspace?.name;
  const userEmail = (userData as { user?: { email?: string } })?.user?.email;
  const signedIn = !!session?.access_token;
  const returnTo = `${location.pathname}${location.search}`;

  const [client, setClient] = useState<{ display_name: string; verified: boolean; redirect_host: string } | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "leaving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const appName = client?.display_name || "This app";

  useEffect(() => {
    if (!signedIn || !requestId) return;
    fetch(`${API_URL}/api/mcp-oauth/requests/${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Bearer ${session!.access_token}` },
    })
      .then(async (r) => {
        if (r.ok) return setClient(await r.json());
        const j = await r.json().catch(() => ({}));
        setError(j.error === "expired" || j.error === "already_used"
          ? "This request expired. Start the connection again from the app."
          : "This request isn't valid. Start the connection again from the app.");
        setState("error");
      })
      .catch(() => { setError("Couldn't reach OpenNous. Reload and try again."); setState("error"); });
  }, [signedIn, requestId, session]);

  const decide = async (decision: "approve" | "deny") => {
    if (!session?.access_token || !workspaceId) return;
    setState("busy");
    try {
      const r = await fetch(`${API_URL}/api/mcp-oauth/requests/${encodeURIComponent(requestId)}/${decision}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.redirect_to) throw new Error("Couldn't finish. Start the connection again from the app.");
      setState("leaving");
      window.location.assign(j.redirect_to);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setState("error");
    }
  };

  const primaryBtn =
    "w-full h-10 rounded-xl flex items-center justify-center gap-2 font-medium text-[13px] bg-[#E0912B] text-[#1a1000] transition-[filter,opacity] hover:brightness-105 disabled:opacity-60";
  const secondaryBtn =
    "w-full h-10 rounded-xl flex items-center justify-center text-[13px] text-[#6B655B] hover:text-[#1A1712] disabled:opacity-60";

  return (
    <div className="relative min-h-screen flex items-center justify-center px-4 text-[#1A1712]" style={PAGE_STYLE}>
      <div className="relative z-10 w-full max-w-[380px] rounded-2xl border border-[#ECEAE4] bg-white p-7 text-center" style={BOX_SHADOW}>
        <img src="/nous-logo.svg" alt="" className="mx-auto h-8 w-8 object-contain" />

        {!requestId ? (
          <>
            <h1 className="mt-5 text-[17px] font-semibold">Nothing to approve</h1>
            <p className="mt-1.5 text-[13px] text-[#6B655B]">Start the connection from the app you're adding OpenNous to.</p>
          </>
        ) : loading ? (
          <p className="mt-5 text-[13px] text-[#6B655B]">Checking your session…</p>
        ) : !signedIn ? (
          <>
            <h1 className="mt-5 text-[17px] font-semibold">Sign in to connect</h1>
            <p className="mt-1.5 text-[13px] text-[#6B655B]">We'll bring you right back here.</p>
            <Link to={authPathWithRedirect("/login", returnTo)} className={`mt-6 ${primaryBtn}`}>
              Sign in <ArrowRight className="h-4 w-4" />
            </Link>
            <Link to={authPathWithRedirect("/signup", returnTo)} className={`mt-1 ${secondaryBtn}`}>
              Create an account
            </Link>
          </>
        ) : state === "error" ? (
          <>
            <h1 className="mt-5 text-[17px] font-semibold">Couldn't connect</h1>
            <p className="mt-1.5 text-[13px] text-[#6B655B]">{error}</p>
          </>
        ) : state === "leaving" ? (
          <p className="mt-5 text-[13px] text-[#6B655B]">Taking you back to {appName}…</p>
        ) : !client ? (
          <p className="mt-5 text-[13px] text-[#6B655B]">One moment…</p>
        ) : (
          <>
            <h1 className="mt-5 text-[17px] font-semibold">{appName} wants to use OpenNous</h1>
            <p className="mt-1.5 text-[13px] text-[#6B655B]">
              As {userEmail || "you"} in {workspaceName || "your workspace"}
            </p>

            <ul className="mt-5 space-y-2 rounded-xl bg-[#FAF8F4] px-4 py-3 text-left">
              <li className="flex items-start gap-2.5 text-[12.5px] text-[#3A352D]">
                <Eye className="mt-[1px] h-4 w-4 flex-shrink-0 text-[#96601f]" strokeWidth={1.75} />
                <span>Read your accounts, people, deals and calls</span>
              </li>
              <li className="flex items-start gap-2.5 text-[12.5px] text-[#3A352D]">
                <PenLine className="mt-[1px] h-4 w-4 flex-shrink-0 text-[#96601f]" strokeWidth={1.75} />
                <span>Record what it learns</span>
              </li>
            </ul>
            <p className="mt-3 text-[11.5px] text-[#6B655B]/80">
              It sees only what you can see. Revoke it any time in Settings.
            </p>

            <button onClick={() => decide("approve")} disabled={state === "busy" || !workspaceId} className={`mt-5 ${primaryBtn}`}>
              {!workspaceId ? "Preparing your workspace…" : "Allow"}
            </button>
            <button onClick={() => decide("deny")} disabled={state === "busy"} className={`mt-1 ${secondaryBtn}`}>
              Cancel
            </button>
            <p className="mt-2 text-[11px] text-[#6B655B]/70">
              {client.verified ? `You'll return to ${client.redirect_host}` : "Only allow this if you just added OpenNous to this app yourself."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
