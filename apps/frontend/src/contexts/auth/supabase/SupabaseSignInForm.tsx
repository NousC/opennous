import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/contexts/AuthContext";
import { useAuthConfig, signupAllowed } from "@/lib/authConfig";
import type { SignInFormProps } from "@/contexts/auth/slotTypes";
import { AuthCard, Field, inputCls, linkCls, submitCls, SubmitArrow } from "./AuthCard";
import { getSupabaseAuthClient } from "./client";

// Self-host sign-in: email + password on Supabase Auth (GET-577). A magic link
// (admin impersonation, agency claim, password reset) also lands here; the
// Supabase client reads the session from the URL and we forward on.
export default function SupabaseSignInForm({ redirectTo, redirectQuery }: SignInFormProps) {
  const { signIn, isAuthenticated, loading: authLoading } = useAuth();
  const authConfig = useAuthConfig();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (!authLoading && isAuthenticated) return <Navigate to={redirectTo} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await signIn(email, password);
    if (error) toast.error(error.message || "Failed to sign in");
    // On success the session change re-renders this into the redirect above.
    setBusy(false);
  };

  const forgot = async () => {
    if (!email) { toast.error("Enter your email first."); return; }
    setBusy(true);
    const { error } = await getSupabaseAuthClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    });
    setBusy(false);
    if (error) toast.error(error.message);
    else toast.success("Check your email for a sign-in link, then set a new password in Settings → Security.");
  };

  return (
    <AuthCard
      heading="Welcome back"
      sub="Sign in to your OpenNous workspace."
      // Closed instances still offer it on the way to a join/invite page (the token is
      // the gate there) and while the owner account has not been created.
      footer={signupAllowed(authConfig, redirectTo) ? (
        <>New to OpenNous? <Link to={`/signup${redirectQuery}`} className={linkCls}>Create an account</Link></>
      ) : undefined}
    >
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Work email" htmlFor="si-email">
          <Input id="si-email" type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)}
            required autoFocus disabled={busy} className={inputCls} autoComplete="email" />
        </Field>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="si-password" className="text-[13.5px] font-normal text-[#2B303A]">Password</label>
            <button type="button" onClick={forgot} disabled={busy} className="text-[13.5px] font-light text-[#6E7480] hover:text-[#C2410C]">
              Forgot password?
            </button>
          </div>
          <Input id="si-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            required disabled={busy} className={inputCls} autoComplete="current-password" />
        </div>
        <Button type="submit" disabled={busy} className={submitCls}>
          <span>{busy ? "Signing in…" : "Sign in"}</span>
          {!busy && <SubmitArrow />}
        </Button>
      </form>
    </AuthCard>
  );
}
