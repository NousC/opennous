import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { Link } from 'react-router-dom';

const COOKIE_CONSENT_KEY = 'nous_cookie_consent';

type ConsentType = 'all' | 'essential' | null;

interface CookieConsent {
  consent: ConsentType;
  timestamp: string;
}

export function CookieConsentBanner() {
  const [showBanner, setShowBanner] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    // Check if user has already given consent
    const storedConsent = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (!storedConsent) {
      // Small delay to avoid flash on page load
      const timer = setTimeout(() => setShowBanner(true), 500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAcceptAll = () => {
    const consent: CookieConsent = {
      consent: 'all',
      timestamp: new Date().toISOString(),
    };
    localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify(consent));
    setShowBanner(false);

    // Enable analytics tracking
    enableAnalytics();
  };

  const handleAcceptEssential = () => {
    const consent: CookieConsent = {
      consent: 'essential',
      timestamp: new Date().toISOString(),
    };
    localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify(consent));
    setShowBanner(false);

    // Disable non-essential tracking
    disableAnalytics();
  };

  const enableAnalytics = () => {
    // PostHog - enable tracking
    if (window.posthog) {
      window.posthog.opt_in_capturing();
    }

    // Google Analytics - enable (if used)
    if (window.gtag) {
      window.gtag('consent', 'update', {
        analytics_storage: 'granted',
      });
    }
  };

  const disableAnalytics = () => {
    // PostHog - disable tracking
    if (window.posthog) {
      window.posthog.opt_out_capturing();
    }

    // Google Analytics - disable (if used)
    if (window.gtag) {
      window.gtag('consent', 'update', {
        analytics_storage: 'denied',
      });
    }
  };

  if (!showBanner) return null;

  const NOUS_BG = 'oklch(99.2% 0.002 80)';
  const NOUS_BG_SOFT = 'oklch(97.5% 0.003 80)';
  const NOUS_FG = 'oklch(14% 0.008 280)';
  const NOUS_FG_SOFT = 'oklch(40% 0.008 280)';
  const NOUS_FG_MUTE = 'oklch(58% 0.006 280)';
  const NOUS_BORDER = 'oklch(93% 0.004 280)';
  const NOUS_BORDER_STRONG = 'oklch(85% 0.005 280)';
  const NOUS_ACCENT = 'oklch(62% 0.16 38)';
  const NOUS_ACCENT_INK = 'oklch(26% 0.07 35)';

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4 md:p-6">
      <div
        className="max-w-2xl mx-auto overflow-hidden"
        style={{
          background: NOUS_BG,
          border: `1px solid ${NOUS_BORDER}`,
          borderRadius: '12px',
          boxShadow: '0 10px 30px -12px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.04)',
        }}
      >
        <div className="p-5 md:p-6">
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <div
                className="mb-3 text-[10.5px] uppercase tracking-[0.14em]"
                style={{
                  fontFamily: 'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
                  color: NOUS_FG_MUTE,
                }}
              >
                # cookies
              </div>
              <p
                className="text-[15px] font-semibold mb-1.5"
                style={{ color: NOUS_FG, letterSpacing: '-0.01em' }}
              >
                We use cookies
              </p>
              <p className="text-[13px] leading-[1.55] mb-4" style={{ color: NOUS_FG_SOFT }}>
                To improve your experience and analyze traffic. You can accept all cookies or only essential ones.{' '}
                <Link
                  to="/cookies"
                  className="underline underline-offset-2 hover:opacity-80"
                  style={{ color: NOUS_ACCENT_INK, textDecorationColor: NOUS_BORDER_STRONG }}
                >
                  Cookie Policy
                </Link>
                {' · '}
                <Link
                  to="/privacy"
                  className="underline underline-offset-2 hover:opacity-80"
                  style={{ color: NOUS_ACCENT_INK, textDecorationColor: NOUS_BORDER_STRONG }}
                >
                  Privacy Policy
                </Link>
              </p>

              {showDetails && (
                <div
                  className="p-4 mb-4 text-[12.5px] space-y-2"
                  style={{
                    background: NOUS_BG_SOFT,
                    border: `1px solid ${NOUS_BORDER}`,
                    borderRadius: '8px',
                  }}
                >
                  <div>
                    <span
                      className="font-mono text-[10.5px] uppercase tracking-[0.12em] mr-2"
                      style={{ color: NOUS_FG }}
                    >
                      essential
                    </span>
                    <span style={{ color: NOUS_FG_SOFT }}>
                      Auth, security, core functionality. Always on.
                    </span>
                  </div>
                  <div>
                    <span
                      className="font-mono text-[10.5px] uppercase tracking-[0.12em] mr-2"
                      style={{ color: NOUS_FG }}
                    >
                      analytics
                    </span>
                    <span style={{ color: NOUS_FG_SOFT }}>
                      PostHog. Helps us improve the product.
                    </span>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={handleAcceptAll}
                  className="px-4 py-2 text-[13px] font-medium transition-opacity hover:opacity-90"
                  style={{
                    background: NOUS_ACCENT,
                    color: 'oklch(99% 0.005 60)',
                    borderRadius: '8px',
                  }}
                >
                  Accept all
                </button>
                <button
                  onClick={handleAcceptEssential}
                  className="px-4 py-2 text-[13px] font-medium transition-colors hover:bg-[oklch(95%_0.005_280)]"
                  style={{
                    background: 'transparent',
                    border: `1px solid ${NOUS_BORDER_STRONG}`,
                    color: NOUS_FG,
                    borderRadius: '8px',
                  }}
                >
                  Essential only
                </button>
                <button
                  onClick={() => setShowDetails(!showDetails)}
                  className="ml-1 font-mono text-[11px] uppercase tracking-[0.12em] transition-opacity hover:opacity-100"
                  style={{ color: NOUS_FG_MUTE, opacity: 0.85 }}
                >
                  {showDetails ? 'less' : 'details'}
                </button>
              </div>
            </div>

            <button
              onClick={handleAcceptEssential}
              className="p-1 flex-shrink-0 transition-opacity hover:opacity-70"
              style={{ color: NOUS_FG_MUTE }}
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Utility function to check consent status
export function getCookieConsent(): ConsentType {
  const stored = localStorage.getItem(COOKIE_CONSENT_KEY);
  if (!stored) return null;

  try {
    const consent: CookieConsent = JSON.parse(stored);
    return consent.consent;
  } catch {
    return null;
  }
}

// Utility to check if analytics is allowed
export function isAnalyticsAllowed(): boolean {
  return getCookieConsent() === 'all';
}

// Type declaration for window
declare global {
  interface Window {
    posthog?: {
      opt_in_capturing: () => void;
      opt_out_capturing: () => void;
    };
    gtag?: (command: string, action: string, params: Record<string, string>) => void;
  }
}
