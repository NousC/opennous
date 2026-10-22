import { useEffect, Suspense } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PAGE_STYLE } from "@/lib/authTheme";
import { SignUpForm } from "@/contexts/auth/select";
import { safeRedirect } from "@/lib/authRedirect";
import { useAuthConfig, signupAllowed } from "@/lib/authConfig";

// Signup is now just the account-creation step — the auth provider's sign-up
// (Clerk's <SignUp> on Cloud, email + password on self-host Supabase Auth) over
// the branded background, matching login. The "operate Nous with your coding agent"
// pitch lives on the marketing home page and in the first conversation with the agent, so
// we don't repeat it here.
const Signup = () => {
  const authConfig = useAuthConfig();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // The CLI flow sends new users here with ?redirect=/cli-login?code=… so the
  // terminal can finish after they create an account. With no param, land on "/"
  // — the agent takes it from there, in the chat.
  const afterAuth = safeRedirect(searchParams.get("redirect"));
  const redirectQuery = searchParams.get("redirect")
    ? `?redirect=${encodeURIComponent(searchParams.get("redirect")!)}`
    : "";

  // Self-host: if registration is closed, there is no signup — send to login. Except
  // while the instance still needs its owner (the setup form), and on the way to a page
  // that redeems a token (a CLI join on /cli-login, an invitation): there the teammate
  // needs a login, and the token, not this page, decides what it gets.
  const allowed = signupAllowed(authConfig, searchParams.get("redirect"));
  useEffect(() => {
    if (!allowed) navigate(`/login${redirectQuery}`, { replace: true });
  }, [allowed, navigate, redirectQuery]);

  // Capture affiliate referral code from URL and persist in localStorage.
  useEffect(() => {
    const ref = searchParams.get("ref") || searchParams.get("affiliate");
    if (ref) localStorage.setItem("nous_affiliate_ref", ref.toUpperCase());
  }, [searchParams]);

  return (
    <div
      className="relative overflow-hidden min-h-screen flex items-center justify-center px-4 py-10 font-geist-mono text-[#1A1712]"
      style={PAGE_STYLE}
    >
      <Suspense fallback={null}>
        <SignUpForm
          afterAuth={afterAuth}
          redirectQuery={redirectQuery}
          setupRequired={authConfig.setupRequired}
          setupToken={searchParams.get("setup") ?? undefined}
        />
      </Suspense>
    </div>
  );
};

export default Signup;
