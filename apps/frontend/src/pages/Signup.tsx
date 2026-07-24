import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SignUp } from "@clerk/react";
import GraphField from "@/components/GraphField";
import { PAGE_STYLE, CLERK_APPEARANCE } from "@/lib/authTheme";
import { safeRedirect } from "@/lib/authRedirect";
import { useAuthConfig } from "@/lib/authConfig";

// Signup is now just the account-creation step — Clerk's <SignUp> over the
// branded background, matching login. The "operate Nous with your coding agent"
// pitch lives on the marketing home page and in the post-signup ConnectGate, so
// we don't repeat it here.
const Signup = () => {
  const { signupsDisabled } = useAuthConfig();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // The CLI flow sends new users here with ?redirect=/cli-login?code=… so the
  // terminal can finish after they create an account. With no param, land on "/"
  // — the first-run gate (ConnectGate) takes it from there.
  const afterAuth = safeRedirect(searchParams.get("redirect"));
  const redirectQuery = searchParams.get("redirect")
    ? `?redirect=${encodeURIComponent(searchParams.get("redirect")!)}`
    : "";

  // Self-host: if registration is closed, there is no signup — send to login.
  useEffect(() => {
    if (signupsDisabled) navigate("/login", { replace: true });
  }, [signupsDisabled, navigate]);

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
      <GraphField />
      <div className="relative z-10">
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

export default Signup;
