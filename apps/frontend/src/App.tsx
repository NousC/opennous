import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { AuthProvider, SsoCallback } from "@/contexts/auth/select";
import { PreviewAuthProvider } from "@/contexts/PreviewAuthProvider";
import { PREVIEW } from "@/lib/preview";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AppRoutes } from "@/components/AppRoutes";
import { CommandPalette } from "@/components/CommandPalette";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { usePostHog } from "@/hooks/usePostHog";
import { lazy, Suspense } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { CookieConsentBanner } from "@/components/CookieConsent";
import { cloud } from "@/lib/cloud";

const lazyPage = (importFn: () => Promise<any>) =>
  lazy(() =>
    importFn().catch((error) => {
      console.error('Failed to load chunk:', error);
      return {
        default: () => (
          <div className="flex flex-col items-center justify-center min-h-screen p-8">
            <h2 className="text-2xl font-semibold mb-2">Failed to load page</h2>
            <p className="text-muted-foreground mb-4">Please refresh the page and try again.</p>
            <button onClick={() => window.location.reload()} className="px-4 py-2 bg-primary text-primary-foreground rounded-md">
              Reload Page
            </button>
          </div>
        ),
      };
    })
  );

const Login           = lazyPage(() => import("./pages/Login"));
const Signup          = lazyPage(() => import("./pages/Signup"));
const AcceptInvitation = lazyPage(() => import("./pages/AcceptInvitation"));
const MemberSetup     = lazyPage(() => import("./pages/MemberSetup"));
const CliLogin        = lazyPage(() => import("./pages/CliLogin"));
const OAuthConsent    = lazyPage(() => import("./pages/OAuthConsent"));
const NotFound        = lazyPage(() => import("./pages/NotFound"));
// Legal pages
const PrivacyPolicy   = lazyPage(() => import("./pages/legal/PrivacyPolicy"));
const TermsOfService  = lazyPage(() => import("./pages/legal/TermsOfService"));
const CookiePolicy    = lazyPage(() => import("./pages/legal/CookiePolicy"));
const Impressum       = lazyPage(() => import("./pages/legal/Impressum"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      retry: 2,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    },
  },
});

const PageLoader = () => (
  <div className="min-h-screen bg-background flex items-center justify-center">
    <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
  </div>
);

// Finalizes a Clerk OAuth redirect (Cloud) and forwards to the redirectUrlComplete
// that was set when the flow started. In preview, and on self-host Supabase Auth,
// there is nothing to finalize, so it bounces home.
const SsoCallbackRoute = () => (PREVIEW ? <Navigate to="/" replace /> : <SsoCallback />);

// Identifies the signed-in user for PostHog. Pageviews are captured by posthog-js
// itself (capture_pageview: 'history_change' in lib/posthog.ts).
function PostHogIdentify() {
  usePostHog();
  return null;
}


// Preview mode swaps the real AuthProvider (Clerk on Cloud, Supabase Auth on
// self-host — contexts/auth/select.tsx) for the fixture-backed one — same
// context, same shape, no credentials. See lib/preview.ts.
const AuthProviderForEnv = PREVIEW ? PreviewAuthProvider : AuthProvider;

const App = () => (
  <ErrorBoundary>
    <ThemeProvider>
    <AuthProviderForEnv>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Sonner />
          <BrowserRouter>
            <PostHogIdentify />
            <Routes>
              {/* Auth. In preview there is no ClerkProvider — the Clerk widgets on
                  these pages would throw into the ErrorBoundary, so bounce home. */}
              <Route path="/login" element={PREVIEW ? <Navigate to="/" replace /> : <Suspense fallback={<PageLoader />}><Login /></Suspense>} />
              <Route path="/signup" element={PREVIEW ? <Navigate to="/" replace /> : <Suspense fallback={<PageLoader />}><Signup /></Suspense>} />
              <Route path="/accept-invitation" element={PREVIEW ? <Navigate to="/" replace /> : <Suspense fallback={<PageLoader />}><AcceptInvitation /></Suspense>} />

              {/* Clerk OAuth (Google) return leg. authenticateWithRedirect sends the
                  browser here; the callback finalizes the session and forwards to the
                  redirectUrlComplete we set (e.g. back to /cli-login). */}
              <Route path="/sso-callback" element={<SsoCallbackRoute />} />

              {/* Onboarding moved to the agent — /onboarding now redirects to Install. */}
              <Route path="/onboarding" element={<Navigate to="/" replace />} />

              {/* Member setup — a teammate who joined via invite connects their own
                  accounts + grabs their agent key. Authed, reachable before the
                  main app (they skip workspace onboarding, which the owner did). */}
              <Route
                path="/member-setup"
                element={
                  <ProtectedRoute>
                    <Suspense fallback={<PageLoader />}><MemberSetup /></Suspense>
                  </ProtectedRoute>
                }
              />

              {/* CLI browser-login approval. PUBLIC on purpose: this is the account-creation
                  step of "one command from zero", so a visitor with no account has to reach
                  it. The page handles its own signed-out state — it sends them to sign up
                  and returns them here with the code intact. Wrapping it in ProtectedRoute
                  would bounce them to /login and drop the code, which is exactly the bug that
                  made the terminal front door only work for existing users. */}
              <Route
                path="/cli-login"
                element={<Suspense fallback={<PageLoader />}><CliLogin /></Suspense>}
              />

              {/* MCP OAuth consent (GET-762): Grok, Claude.ai, ChatGPT etc. send the user
                  here to approve access. Public for the same reason as /cli-login. */}
              <Route
                path="/oauth/consent"
                element={<Suspense fallback={<PageLoader />}><OAuthConsent /></Suspense>}
              />

              {/* The Workspace layer's public pages (the live ops dashboard), when this build has it. */}
              {cloud.publicRoutes}

              {/* Legal */}
              <Route path="/privacy" element={<Suspense fallback={<PageLoader />}><PrivacyPolicy /></Suspense>} />
              <Route path="/terms" element={<Suspense fallback={<PageLoader />}><TermsOfService /></Suspense>} />
              <Route path="/cookies" element={<Suspense fallback={<PageLoader />}><CookiePolicy /></Suspense>} />
              <Route path="/impressum" element={<Suspense fallback={<PageLoader />}><Impressum /></Suspense>} />

              {/* App — sidebar-free, Mind is the shell */}
              <Route
                path="/*"
                element={
                  <ProtectedRoute>
                    <AppRoutes />
                    <CommandPalette />
                  </ProtectedRoute>
                }
              />

              <Route path="*" element={<Suspense fallback={<PageLoader />}><NotFound /></Suspense>} />
            </Routes>
            <CookieConsentBanner />
          </BrowserRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </AuthProviderForEnv>
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
