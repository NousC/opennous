import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Field, inputCls, linkCls, submitAccentCls, SubmitArrow } from "./AuthCard";
import { getSupabaseAuthClient } from "./client";

// Email + password account creation on Supabase Auth (GET-577). With "Confirm
// email" on in the Supabase project there is no session yet: we say so, and the
// email's link brings them back to `afterAuth`. With it off they are signed in
// at once and the auth context takes it from there.
// Self-host set-up (setupRequired): the owner's sign-up carries the setup token in
// user_metadata.nous_setup_token, which the API checks before making them the owner, and the
// company name in user_metadata.company_name, which names their team and workspace. Nobody
// can have an account yet then, so there is no "Sign in" link.
export function SignUpFields({ fixedEmail, afterAuth, signInHref, setupRequired, setupToken }: {
  fixedEmail?: string; afterAuth: string; signInHref: string; setupRequired?: boolean; setupToken?: string;
}) {
  const [company, setCompany] = useState("");
  const [name, setName] = useState("");
  const [setup, setSetup] = useState(setupToken ?? "");
  const [email, setEmail] = useState(fixedEmail ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { data, error } = await getSupabaseAuthClient().auth.signUp({
      email,
      password,
      options: {
        data: {
          ...(name.trim() ? { name: name.trim(), full_name: name.trim() } : {}),
          ...(setupRequired && company.trim() ? { company_name: company.trim() } : {}),
          ...(setup.trim() ? { nous_setup_token: setup.trim() } : {}),
        },
        emailRedirectTo: `${window.location.origin}${afterAuth}`,
      },
    });
    setBusy(false);
    if (error) { toast.error(error.message || "Could not create the account"); return; }
    if (!data.session) setSentTo(email);
  };

  if (sentTo) {
    return (
      <div className="mt-6 rounded-md bg-white p-4 text-[14px] leading-relaxed text-[#2B303A] shadow-[inset_0_0_0_1px_rgba(14,17,22,0.08)]">
        We sent a confirmation link to <span className="font-normal text-[#0E1116]">{sentTo}</span>. Open it to finish signing up.
      </div>
    );
  }

  return (
    <>
      <form onSubmit={submit} className="mt-6 space-y-4">
        {setupRequired && (
          <Field label="Company name" htmlFor="su-company">
            <Input id="su-company" placeholder="Acme" value={company} onChange={(e) => setCompany(e.target.value)}
              required maxLength={80} disabled={busy} className={inputCls} autoFocus autoComplete="organization" />
          </Field>
        )}
        <Field label="Your name" htmlFor="su-name">
          <Input id="su-name" placeholder="Alex Morgan" value={name} onChange={(e) => setName(e.target.value)}
            disabled={busy} className={inputCls} autoFocus={!setupRequired} autoComplete="name" />
        </Field>
        <Field label="Work email" htmlFor="su-email">
          <Input id="su-email" type="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)}
            required disabled={busy || !!fixedEmail} className={inputCls} autoComplete="email" />
        </Field>
        <Field label="Password" htmlFor="su-password" hint="At least 8 characters">
          <Input id="su-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            required minLength={8} disabled={busy} className={inputCls} autoComplete="new-password" />
        </Field>
        {setupRequired && !setupToken && (
          <Field label="Setup token" htmlFor="su-setup" hint="SELFHOST_SETUP_TOKEN in nous.env">
            <Input id="su-setup" value={setup} onChange={(e) => setSetup(e.target.value)}
              required disabled={busy} className={inputCls} autoComplete="off" />
          </Field>
        )}
        <Button type="submit" disabled={busy} className={submitAccentCls}>
          <span>{busy ? "Creating…" : setupRequired ? "Create workspace" : "Create account"}</span>
          {!busy && <SubmitArrow />}
        </Button>
      </form>
      {!setupRequired && (
        <p className="mt-6 border-t border-[rgba(14,17,22,0.06)] pt-[18px] text-[15px] text-[#6E7480]">
          Already have an account? <Link to={signInHref} className={linkCls}>Sign in</Link>
        </p>
      )}
    </>
  );
}
