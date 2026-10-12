import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import type { SignUpFormProps } from "@/contexts/auth/slotTypes";
import { AuthCard } from "./AuthCard";
import { SignUpFields } from "./SignUpFields";

export default function SupabaseSignUpForm({ afterAuth, redirectQuery, setupRequired, setupToken }: SignUpFormProps) {
  const { isAuthenticated, loading } = useAuth();
  // With autoconfirm the sign-up returns a session at once: go where the person was
  // headed (back to /cli-login to approve, for a teammate joining from the CLI).
  if (!loading && isAuthenticated) return <Navigate to={afterAuth} replace />;
  return (
    <AuthCard
      heading={setupRequired ? "Set up your workspace" : "Create your account"}
      sub={setupRequired ? "You'll be the owner. Invite your team once you're in." : undefined}
    >
      <SignUpFields
        afterAuth={afterAuth}
        signInHref={`/login${redirectQuery}`}
        setupRequired={setupRequired}
        setupToken={setupToken}
      />
    </AuthCard>
  );
}
