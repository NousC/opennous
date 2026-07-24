import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { SignUp } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/components/ui/sonner";
import { Loader2 } from "lucide-react";
import GraphField from "@/components/GraphField";
import { PAGE_STYLE, BOX_SHADOW, CLERK_APPEARANCE } from "@/lib/authTheme";

// Match the branded auth aesthetic (see Login.tsx / opennous.cloud): peach
// canvas + constellation field, cream terminal card with ● ● ● titlebar, mono
// type, coral accent.
// The card chrome (titlebar + logo header) shared by every non-auth state.
function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="relative overflow-hidden min-h-screen flex items-center justify-center px-4 font-geist-mono text-[#1A1712]"
      style={PAGE_STYLE}
    >
      <GraphField />
      <div
        className="relative z-10 w-full max-w-[380px] overflow-hidden rounded-lg border border-[#E4DED1] bg-[#FBFAF5]"
        style={BOX_SHADOW}
      >
        <div className="flex items-center gap-2 border-b border-[#E4DED1] px-4 py-2 text-xs text-[#6B655B]">
          <span className="text-[#96601f]/80">●</span>
          <span className="text-[#E0912B]/80">●</span>
          <span className="text-[#96601f]/60">●</span>
          <span className="ml-1">nous — {title}</span>
        </div>
        <div className="p-6">
          <div className="flex items-center gap-2">
            <img src="/nous-logo.svg" alt="" className="w-5 h-5 object-contain" />
            <span className="font-fraunces font-semibold text-[16px] tracking-[-0.01em] text-[#1A1712]">nous</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function AcceptInvitation() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { isAuthenticated, session, refreshUserData } = useAuth();
  const token = searchParams.get("token");
  // Return here after Clerk auth (Google redirect, or the "sign in instead" link
  // going out to /login) so the auto-accept effect fires with the invite in hand.
  const invitePath = token ? `/accept-invitation?token=${encodeURIComponent(token)}` : "/accept-invitation";

  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [invitation, setInvitation] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const acceptingRef = useRef(false);

  // Load invitation details
  useEffect(() => {
    if (!token) {
      setError("Invalid invitation link");
      setLoading(false);
      return;
    }

    const loadInvitation = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL ?? "";
        const response = await fetch(`${apiUrl}/api/invitations/${token}`);

        if (response.ok) {
          const data = await response.json();
          setInvitation(data.invitation);
        } else {
          const errorData = await response.json().catch(() => ({ error: "Invitation not found" }));
          setError(errorData.detail || errorData.error || "Invitation not found");
        }
      } catch (err: any) {
        console.error("Failed to load invitation:", err);
        setError(err.message || "Failed to load invitation");
      } finally {
        setLoading(false);
      }
    };

    loadInvitation();
  }, [token]);

  const handleAccept = useCallback(async () => {
    if (!token) {
      setError("Invalid invitation token");
      return;
    }
    if (!session?.access_token) return;

    // Guard against a double network call — the auto-accept effect and the button
    // can both trigger this. The server is idempotent too, but firing once keeps
    // it clean.
    if (acceptingRef.current) return;
    acceptingRef.current = true;
    setAccepting(true);
    setError(null);
    try {
      const apiUrl = import.meta.env.VITE_API_URL ?? "";
      const response = await fetch(`${apiUrl}/api/invitations/${token}/accept`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();
        toast.success(`You've joined ${data.team?.name || "the team"}!`);

        if (refreshUserData) {
          await refreshUserData();
        }

        // A member/viewer joins an already-set-up workspace, so they skip the
        // workspace onboarding and get the light member setup (connect their own
        // accounts + grab their scoped agent key). Owners/admins go to the app.
        const dest = (data.role === "member" || data.role === "viewer") ? "/member-setup" : "/";
        setTimeout(() => {
          navigate(dest);
        }, 500);
      } else if (response.status === 409) {
        // Not provisioned yet — retry silently once the user row exists, no scary
        // error. This is the transient "internal error" flash we're killing.
        acceptingRef.current = false;
        setTimeout(() => { if (refreshUserData) refreshUserData(); handleAcceptRef.current?.(); }, 1200);
      } else {
        const errorData = await response.json().catch(() => ({ error: "Failed to accept invitation" }));
        const errorMessage = errorData.detail || errorData.error || "Failed to accept invitation";
        toast.error(errorMessage);
        setError(errorMessage);
        acceptingRef.current = false; // allow a manual retry
      }
    } catch (err: any) {
      console.error("Failed to accept invitation:", err);
      const errorMessage = err.message || "Failed to accept invitation";
      toast.error(errorMessage);
      setError(errorMessage);
      acceptingRef.current = false; // allow a manual retry
    } finally {
      setAccepting(false);
    }
  }, [token, session, navigate, refreshUserData]);

  // Lets the 409-retry path call the latest handleAccept without a circular dep.
  const handleAcceptRef = useRef(handleAccept);
  handleAcceptRef.current = handleAccept;

  // Frictionless path: once the invited person is authenticated (having completed
  // Clerk sign-up/sign-in on this page, or returned from Google), auto-accept —
  // but ONLY when the signed-in email matches the invite, so a wrong-account
  // visitor still sees the mismatch screen instead of a silent failed accept.
  const autoFired = useRef(false);
  useEffect(() => {
    if (autoFired.current) return;
    if (accepting || error) return;
    if (!isAuthenticated || !session?.access_token || !invitation) return;
    const sameEmail = invitation.email?.toLowerCase() === session.user?.email?.toLowerCase();
    if (!sameEmail) return;
    autoFired.current = true;
    // Provision the user row first (lazily created by /me), then accept — otherwise
    // accept can race ahead of provisioning and flash a transient error.
    (async () => {
      if (refreshUserData) { try { await refreshUserData(); } catch { /* best-effort */ } }
      await new Promise(r => setTimeout(r, 400));
      handleAccept();
    })();
  }, [isAuthenticated, session, invitation, accepting, error, handleAccept, refreshUserData]);

  if (loading) {
    return (
      <Shell title="invitation">
        <div className="mt-6 flex items-center gap-2 text-sm text-[#6B655B]">
          <Loader2 className="h-4 w-4 animate-spin text-[#96601f]" /> Loading your invitation…
        </div>
      </Shell>
    );
  }

  if (error && !invitation) {
    return (
      <Shell title="invitation">
        <h1 className="mt-4 font-fraunces text-[26px] font-semibold tracking-[-0.02em] text-[#1A1712]">This link isn't valid</h1>
        <p className="mt-1 text-xs text-[#6B655B]">{error}</p>
        <Button
          onClick={() => navigate("/login")}
          className="mt-5 w-full h-11 rounded-lg font-medium text-sm bg-[#E0912B] hover:brightness-105 text-[#1a1000]"
        >
          Go to sign in
        </Button>
      </Shell>
    );
  }

  if (!invitation) {
    return null;
  }

  // Authenticated: either accept (email matches) or show the mismatch guard.
  if (isAuthenticated && session) {
    if (invitation.email.toLowerCase() !== session.user?.email?.toLowerCase()) {
      return (
        <Shell title="invitation">
          <h1 className="mt-4 font-fraunces text-[26px] font-semibold tracking-[-0.02em] text-[#1A1712]">Wrong account</h1>
          <div className="mt-3 rounded-lg border border-[#E4DED1] bg-[#EFEBE2] p-3 text-xs text-[#6B655B] leading-relaxed">
            This invite is for <span className="font-semibold text-[#1A1712]">{invitation.email}</span>, but you're signed in as <span className="font-semibold text-[#1A1712]">{session.user?.email}</span>. Sign out and use the invited account.
          </div>
          <Button
            onClick={() => navigate("/login")}
            className="mt-5 w-full h-11 rounded-lg font-medium text-sm bg-[#E0912B] hover:brightness-105 text-[#1a1000]"
          >
            Go to sign in
          </Button>
        </Shell>
      );
    }

    return (
      <Shell title="invitation">
        <h1 className="mt-4 font-fraunces text-[26px] font-semibold tracking-[-0.02em] text-[#1A1712]">Joining {invitation.team?.name || "the team"}…</h1>
        <p className="mt-1 text-xs text-[#6B655B]">You're signed in as {session.user?.email}.</p>
        {error && (
          <div className="mt-3 rounded-lg border border-[#e4b8a6] bg-[#fdf1ec] p-3 text-xs text-[#96601f]">{error}</div>
        )}
        <Button
          onClick={handleAccept}
          disabled={accepting}
          className="mt-5 w-full h-12 rounded-lg pl-5 pr-1.5 flex items-center justify-between gap-2 font-medium text-sm bg-[#E0912B] hover:brightness-105 text-[#1a1000] transition-transform hover:scale-[1.005] disabled:opacity-60 disabled:hover:scale-100"
        >
          <span>{accepting ? "Joining…" : "Accept invitation"}</span>
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-[#1a1000] text-[#E0912B]" aria-hidden="true">
            {accepting ? <Loader2 className="h-4 w-4 animate-spin" /> : "→"}
          </span>
        </Button>
      </Shell>
    );
  }

  // Not signed in: invite context + Clerk <SignUp>, prefilled to the invited
  // email. Clerk handles Google, email + email-code, and password. On completion
  // (or return from Google) the auto-accept effect above fires. Existing users
  // use the widget's "Sign in" link, which routes through /login and back here.
  const inviter = invitation.invited_by?.name || invitation.invited_by?.email || "Someone";
  return (
    <div
      className="relative overflow-hidden min-h-screen flex items-center justify-center px-4 py-10 font-geist-mono text-[#1A1712]"
      style={PAGE_STYLE}
    >
      <GraphField />
      <div className="relative z-10 w-full max-w-[400px] flex flex-col items-center gap-4">
        <div className="w-full overflow-hidden rounded-lg border border-[#E4DED1] bg-[#FBFAF5] p-5" style={BOX_SHADOW}>
          <div className="flex items-center gap-2">
            <img src="/nous-logo.svg" alt="" className="w-5 h-5 object-contain" />
            <span className="font-fraunces font-semibold text-[16px] tracking-[-0.01em] text-[#1A1712]">nous</span>
          </div>
          <h1 className="mt-3 font-fraunces text-[24px] font-semibold tracking-[-0.02em] text-[#1A1712]">You're invited</h1>
          <p className="mt-1 text-xs text-[#6B655B] leading-relaxed">
            {inviter} invited you to join <span className="font-semibold text-[#1A1712]">{invitation.team?.name || "the team"}</span> as {invitation.role}. Create your account as <span className="font-semibold text-[#1A1712]">{invitation.email}</span> to join.
          </p>
        </div>

        <SignUp
          routing="virtual"
          initialValues={{ emailAddress: invitation.email }}
          signInUrl={`/login?redirect=${encodeURIComponent(invitePath)}`}
          forceRedirectUrl={invitePath}
          signInForceRedirectUrl={invitePath}
          appearance={CLERK_APPEARANCE}
        />
      </div>
    </div>
  );
}
