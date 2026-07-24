import { useSearchParams } from "react-router-dom";
import { SignIn } from "@clerk/react";
import GraphField from "@/components/GraphField";
import { PAGE_STYLE } from "@/lib/authTheme";
import { safeRedirect } from "@/lib/authRedirect";

// Sign-in keeps the branded Nous background but hands the actual credential flow
// to Clerk's <SignIn> widget — which brings Google, password, password-reset, the
// "Secured by Clerk" badge, and (for admin impersonation / agency claim links)
// automatic ?__clerk_ticket= consumption, all for free.
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
      <GraphField />
      <div className="relative z-10">
        <SignIn
          routing="virtual"
          signUpUrl={`/signup${redirectQuery}`}
          forceRedirectUrl={redirectTo}
          appearance={{
            variables: {
              colorPrimary: "#E0912B",
              colorText: "#1A1712",
              colorTextSecondary: "#6B655B",
              colorBackground: "#FBFAF5",
              colorInputBackground: "#FBFAF5",
              colorInputText: "#1A1712",
              borderRadius: "0.5rem",
            },
            elements: {
              rootBox: "w-full",
              card: "border border-[#E4DED1] bg-[#FBFAF5]",
              headerTitle: "font-fraunces",
              formButtonPrimary:
                "bg-[#E0912B] hover:brightness-105 text-[#1a1000] normal-case",
            },
          }}
        />
      </div>
    </div>
  );
};

export default Login;
