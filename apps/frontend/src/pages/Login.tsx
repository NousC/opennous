import { Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { PAGE_STYLE } from "@/lib/authTheme";
import { safeRedirect } from "@/lib/authRedirect";
import { SignInForm } from "@/contexts/auth/select";

// Sign-in keeps the branded Nous background; the credential form is the auth
// provider's: Clerk's <SignIn> on Cloud, an email + password form on Supabase
// Auth for self-host (contexts/auth/select.tsx).
const Login = () => {
  const [searchParams] = useSearchParams();
  // Where to land after auth — usually "/", but the CLI flow sends us back to
  // /cli-login?code=… so the terminal can finish. See lib/authRedirect.
  const redirectTo = safeRedirect(searchParams.get("redirect"));
  const redirectQuery = searchParams.get("redirect")
    ? `?redirect=${encodeURIComponent(searchParams.get("redirect")!)}`
    : "";

  return (
    <div
      className="relative overflow-hidden min-h-screen flex items-center justify-center px-4 font-geist-mono text-[#1A1712]"
      style={PAGE_STYLE}
    >
      <Suspense fallback={null}>
        <SignInForm redirectTo={redirectTo} redirectQuery={redirectQuery} />
      </Suspense>
    </div>
  );
};

export default Login;
