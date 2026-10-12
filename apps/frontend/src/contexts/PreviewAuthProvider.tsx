// PreviewAuthProvider — the credential-free stand-in for AuthProvider.
//
// Mounted by App.tsx ONLY when lib/preview.ts PREVIEW is true (dev + no Clerk
// key). Feeds the exact AuthContextType shape through the same AuthContext, so
// useAuth(), ProtectedRoute, useOnboarding, usePlan and every page work
// untouched. userData is a fixture /me body pointing at the mock API's
// workspace; the Bearer token is a stub the mock server ignores.
//
// It also renders the ROLE SWITCHER — a small fixed pill (bottom-right) that
// flips userData.workspace_role between admin (manager view) and member (rep
// view), persisted in localStorage, so the manager-only Reporting tab and the
// rep-only My Studio tab can both be experienced on one localhost.
import { useMemo, useState, type ReactNode } from "react";
import { AuthContext, type AuthContextType } from "./AuthContext";

const ROLE_KEY = "nous.preview.role";

function readRole(): "admin" | "member" {
  try {
    return localStorage.getItem(ROLE_KEY) === "member" ? "member" : "admin";
  } catch {
    return "admin";
  }
}

export function PreviewAuthProvider({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<"admin" | "member">(readRole);

  const pickRole = (r: "admin" | "member") => {
    setRole(r);
    try { localStorage.setItem(ROLE_KEY, r); } catch { /* ignore */ }
  };

  // The workspace the mock API serves; keep the id in sync with preview/world.mjs.
  try { localStorage.setItem("selectedWorkspaceId", "ws-preview"); } catch { /* ignore */ }

  // Manager previews as Avery (u1); rep previews as Jordan (u2) — matching the
  // fixture world's owners/assignees so "my commitments" style filters work.
  const previewUser = role === "admin"
    ? { id: "u1", email: "avery@opennous.cloud", name: "Avery Castellan" }
    : { id: "u2", email: "jordan@opennous.cloud", name: "Jordan Reyes" };

  const value = useMemo<AuthContextType>(() => ({
    user: { id: previewUser.id, email: previewUser.email },
    session: { access_token: "preview-token", user: { id: previewUser.id, email: previewUser.email } },
    loading: false,
    userDataLoading: false,
    isAuthenticated: true,
    userData: {
      user: {
        id: previewUser.id, email: previewUser.email, name: previewUser.name,
        profile_picture_url: null, is_admin: false,
      },
      team: { id: "team-preview", name: "Nous" },
      workspace: { id: "ws-preview", name: "Nous", icon: null, business_type: "software" },
      onboarding_completed: true,
      is_founder: role === "admin",
      workspace_role: role,   // ← the role switcher's output; roleOf() reads this
      trial: { is_active: false, ends_at: null },
      billing_enabled: true,
      plan_enforcement: false,
      self_hosted: false,
      app_commit: null,
    },
    onboardingCompleted: true,
    signIn: async () => ({ error: null }),
    signUp: async () => ({ error: null, data: null }),
    signInWithGoogle: async () => ({ error: null }),
    verifyOtp: async () => ({ error: null, data: null }),
    signOut: async () => { /* preview: nowhere to sign out to */ },
    refreshUserData: () => { /* preview: userData is static */ },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [role]);

  return (
    <AuthContext.Provider value={value}>
      {children}
      {/* Preview chrome: the role switcher. Fixed, tiny, and never in the way. */}
      <div className="fixed bottom-3 right-3 z-[9999] flex items-center gap-1 rounded-full border border-border bg-background/95 backdrop-blur px-1.5 py-1 shadow-lg">
        <span className="pl-1.5 pr-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Preview as</span>
        {([["admin", "Manager"], ["member", "Rep"]] as const).map(([r, label]) => (
          <button
            key={r}
            onClick={() => pickRole(r)}
            className={
              role === r
                ? "px-2 py-0.5 rounded-full text-[11px] font-semibold bg-foreground text-background"
                : "px-2 py-0.5 rounded-full text-[11px] font-medium text-muted-foreground hover:text-foreground"
            }
          >
            {label}
          </button>
        ))}
      </div>
    </AuthContext.Provider>
  );
}
