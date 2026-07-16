import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AppRoutes } from "@/components/AppRoutes";
import { CommandPalette } from "@/components/CommandPalette";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { usePostHog } from "@/hooks/usePostHog";
import { useEffect, lazy, Suspense } from "react";
import { posthog } from "@/lib/posthog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { CookieConsentBanner } from "@/components/CookieConsent";

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
const NotFound        = lazyPage(() => import("./pages/NotFound"));
const LivePage        = lazyPage(() => import("./pages/Live"));
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

function PostHogPageView() {
  const location = useLocation();
  usePostHog();

  useEffect(() => {
    posthog?.capture('$pageview', {
      $current_url: window.location.href,
      path: location.pathname,
    });
  }, [location]);

  return null;
}


const App = () => (
  <ErrorBoundary>
    <ThemeProvider>
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Sonner position="top-center" richColors />
          <BrowserRouter>
            <PostHogPageView />
            <Routes>
              {/* Auth */}
              <Route path="/login" element={<Suspense fallback={<PageLoader />}><Login /></Suspense>} />
              <Route path="/signup" element={<Suspense fallback={<PageLoader />}><Signup /></Suspense>} />
              <Route path="/accept-invitation" element={<Suspense fallback={<PageLoader />}><AcceptInvitation /></Suspense>} />

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

              {/* Public — live ops dashboard, no auth */}
              <Route path="/live" element={<Suspense fallback={<PageLoader />}><LivePage /></Suspense>} />

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
    </AuthProvider>
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
