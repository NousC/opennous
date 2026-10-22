import { Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { SignInLayout } from "@/components/auth/AuthLayout";
import { safeRedirect } from "@/lib/authRedirect";
import { SignInForm } from "@/contexts/auth/select";
import { useAuthConfig, signupAllowed } from "@/lib/authConfig";
import { IS_CLERK } from "@/lib/authProvider";

// Sign-in in the website v2 design (GET-958): the card on the dotted radar. The credential form
// is the auth provider's: Clerk's <SignIn> on Cloud, an email + password form on Supabase Auth
// for self-host (contexts/auth/select.tsx).
const Login = () => {
  const [searchParams] = useSearchParams();
  // Where to land after auth — usually "/", but the CLI flow sends us back to
  // /cli-login?code=… so the terminal can finish. See lib/authRedirect.
  const redirectTo = safeRedirect(searchParams.get("redirect"));
  const redirectQuery = searchParams.get("redirect")
    ? `?redirect=${encodeURIComponent(searchParams.get("redirect")!)}`
    : "";

  // The way to sign up, top right, only where signing up is open. Cloud's Free plan is the
  // website's "Start for free"; a self-host instance just creates an account.
  const authConfig = useAuthConfig();
  const signUpHref = signupAllowed(authConfig, searchParams.get("redirect")) ? `/signup${redirectQuery}` : undefined;

  return (
    <SignInLayout signUpHref={signUpHref} signUpLabel={IS_CLERK ? "Start for free" : "Create an account"}>
      <Suspense fallback={null}>
        <SignInForm redirectTo={redirectTo} redirectQuery={redirectQuery} />
      </Suspense>
    </SignInLayout>
  );
};

export default Login;
