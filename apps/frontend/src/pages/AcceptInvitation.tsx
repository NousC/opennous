import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/components/ui/sonner";
import { Loader2, Lock } from "lucide-react";
import GraphField from "@/components/GraphField";
import { PAGE_STYLE, BOX_SHADOW } from "@/lib/authTheme";

// Match the branded auth aesthetic (see Login.tsx / opennous.cloud): peach
// canvas + constellation field, cream terminal card with ● ● ● titlebar, mono
// type, coral accent.
// The card chrome (titlebar + logo header) shared by every state.
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
  const { isAuthenticated, session, signIn, signUp, signInWithGoogle, refreshUserData } = useAuth();
  const token = searchParams.get("token");

  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [invitation, setInvitation] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  // Sign up/login form state
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [isSignUp, setIsSignUp] = useState(true); // Default to sign up
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [pendingAccept, setPendingAccept] = useState(false);
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
          
          // Pre-fill email from invitation
          if (data.invitation?.email) {
            setEmail(data.invitation.email);
          }
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

    // If no session, show auth form
    if (!session?.access_token) {
      setShowEmailForm(true);
      setIsSignUp(true);
      return;
    }

    // Guard against a double network call — the auto-accept effect, the OAuth
    // return, and the button can all trigger this. The server is idempotent too,
    // but firing once keeps it clean.
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

        // Refresh user data to update onboarding status
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

  // Auto-accept invitation when session becomes available after auth
  useEffect(() => {
    if (pendingAccept && session?.access_token && invitation && !accepting && !error) {
      // Session is now available, accept the invitation
      const acceptInvitation = async () => {
        setPendingAccept(false);
        // Small delay to ensure everything is ready
        await new Promise(resolve => setTimeout(resolve, 500));
        if (refreshUserData) {
          await refreshUserData();
        }
        await new Promise(resolve => setTimeout(resolve, 300));
        handleAccept();
      };
      acceptInvitation();
    }
  }, [pendingAccept, session, invitation, accepting, error, handleAccept, refreshUserData]);

  // Frictionless path: when the user lands back on this page already
  // authenticated (e.g. returning from Google sign-in, where the pendingAccept
  // flag was wiped by the full-page redirect), auto-accept — but ONLY when the
  // signed-in email matches the invite, so a wrong-account visitor still sees the
  // mismatch screen instead of a silent failed accept. One less click.
  const autoFired = useRef(false);
  useEffect(() => {
    if (autoFired.current) return;
    if (accepting || error || pendingAccept) return;
    if (!isAuthenticated || !session?.access_token || !invitation) return;
    const sameEmail = invitation.email?.toLowerCase() === session.user?.email?.toLowerCase();
    if (!sameEmail) return;
    autoFired.current = true;
    // Provision the user row first (lazily created by /me), then accept — otherwise
    // accept can race ahead of provisioning and flash a transient error. Mirrors
    // the pendingAccept effect.
    (async () => {
      if (refreshUserData) { try { await refreshUserData(); } catch { /* best-effort */ } }
      await new Promise(r => setTimeout(r, 400));
      handleAccept();
    })();
  }, [isAuthenticated, session, invitation, accepting, error, pendingAccept, handleAccept, refreshUserData]);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim() || !name.trim()) {
      toast.error("Please fill in all fields");
      return;
    }

    setAuthLoading(true);
    try {
        const { error, data } = await signUp(email, password, name);
        if (error) {
          toast.error(error.message || "Failed to sign up");
        setAuthLoading(false);
          return;
        }
      
      // If signup created a session immediately, set flag to auto-accept when session is ready
      if (data?.session) {
        toast.success("Account created!");
        setPendingAccept(true);
        setShowEmailForm(false);
        setAuthLoading(false);
      } else {
        // Email confirmation required
        toast.success("Account created! Please check your email to confirm your account, then sign in.");
        setIsSignUp(false);
        setAuthLoading(false);
      }
    } catch (err: any) {
      toast.error(err.message || "Authentication failed");
      setAuthLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      toast.error("Please fill in all fields");
      return;
    }

    setAuthLoading(true);
    try {
        const { error } = await signIn(email, password);
        if (error) {
          toast.error(error.message || "Failed to sign in");
        setAuthLoading(false);
          return;
        }
        toast.success("Signed in successfully!");
      setPendingAccept(true);
      setShowEmailForm(false);
      setAuthLoading(false);
    } catch (err: any) {
      toast.error(err.message || "Authentication failed");
      setAuthLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    // Come back to THIS invite page (token in the URL) after Google, so the
    // accept can auto-fire on return — otherwise the redirect lands on the
    // dashboard and the invite is forgotten.
    const returnPath = token ? `/accept-invitation?token=${encodeURIComponent(token)}` : "/accept-invitation";
    const { error } = await signInWithGoogle(returnPath);

    if (error) {
      toast.error(error.message || "Failed to sign up with Google");
      setAuthLoading(false);
    }
    // On success the browser redirects to Google, then back to returnPath; the
    // auto-accept effect below fires once the session is live. No local flag
    // needed (a full-page redirect would wipe it anyway).
  };

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

  // If authenticated, show accept (or the email-mismatch guard).
  if (isAuthenticated && session && !showEmailForm) {
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

  // Invite / create-account screen — branded terminal card.
  const inviter = invitation.invited_by?.name || invitation.invited_by?.email || "Someone";
  return (
    <Shell title="invitation">
      <h1 className="mt-4 font-fraunces text-[26px] font-semibold tracking-[-0.02em] text-[#1A1712]">You're invited</h1>
      <p className="mt-1 text-xs text-[#6B655B] leading-relaxed">
        {inviter} invited you to join <span className="font-semibold text-[#1A1712]">{invitation.team?.name || "the team"}</span> as {invitation.role}. Create your account to join.
      </p>

      <div className="mt-5 space-y-3">
        {/* Google — the frictionless path */}
        <Button
          type="button"
          onClick={handleGoogleSignIn}
          variant="outline"
          className="w-full h-11 rounded-lg flex items-center justify-center gap-2.5 font-medium text-sm border-[#E4DED1] bg-[#FBFAF5] hover:bg-[#EFEBE2] text-[#1A1712]"
          disabled={authLoading}
        >
          <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Continue with Google
        </Button>

        {!showEmailForm ? (
          <button
            type="button"
            onClick={() => setShowEmailForm(true)}
            className="w-full flex items-center justify-center gap-2 text-xs text-[#6B655B] hover:text-[#96601f] py-1"
          >
            <Lock className="h-3.5 w-3.5" /> or create an account with email
          </button>
        ) : (
          <>
            <div className="relative py-1">
              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-[#E4DED1]" /></div>
              <div className="relative flex justify-center"><span className="px-3 text-[10px] uppercase tracking-[0.12em] text-[#6B655B] bg-[#FBFAF5]">or</span></div>
            </div>
            <form onSubmit={handleSignup} className="space-y-3">
              <Input
                type="text" placeholder="Full name" value={name}
                onChange={(e) => setName(e.target.value)} required autoFocus disabled={authLoading}
                className="h-11 rounded-lg text-sm border-[#E4DED1] bg-[#FBFAF5] text-[#1A1712] placeholder:text-[#6B655B] focus-visible:ring-[#96601f] focus-visible:border-[#96601f]"
              />
              <Input
                type="email" value={email} readOnly disabled
                className="h-11 rounded-lg text-sm border-[#E4DED1] bg-[#EFEBE2] text-[#6B655B]"
              />
              <Input
                type="password" placeholder="Choose a password" value={password}
                onChange={(e) => setPassword(e.target.value)} required minLength={6} disabled={authLoading}
                className="h-11 rounded-lg text-sm border-[#E4DED1] bg-[#FBFAF5] text-[#1A1712] placeholder:text-[#6B655B] focus-visible:ring-[#96601f] focus-visible:border-[#96601f]"
              />
              <Button
                type="submit" disabled={authLoading}
                className="w-full h-12 rounded-lg pl-5 pr-1.5 flex items-center justify-between gap-2 font-medium text-sm bg-[#E0912B] hover:brightness-105 text-[#1a1000] transition-transform hover:scale-[1.005] disabled:opacity-60 disabled:hover:scale-100"
              >
                <span>{authLoading ? "Creating account…" : "Create account & join"}</span>
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-[#1a1000] text-[#E0912B]" aria-hidden="true">→</span>
              </Button>
            </form>
          </>
        )}
      </div>

      <p className="mt-4 text-center text-[11px] text-[#6B655B]/80">
        Joining as {invitation.email}
      </p>
    </Shell>
  );
}
