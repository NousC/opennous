import posthog from 'posthog-js';

// Initialize PostHog
export const initPostHog = () => {
  const apiKey = import.meta.env.VITE_POSTHOG_KEY;
  const apiHost = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com';

  if (!apiKey) {
    console.warn('PostHog API key not found. Analytics will be disabled.');
    return null;
  }

  posthog.init(apiKey, {
    api_host: apiHost,
    // Don't track until the user has opted in (see CookieConsent). Capturing stays
    // off until opt_in_capturing() — which CookieConsent calls on "Accept all", and
    // which we re-apply below for a returning visitor who already consented.
    opt_out_capturing_by_default: true,
    // Enable automatic pageview tracking
    loaded: (posthog) => {
      try {
        const stored = localStorage.getItem('nous_cookie_consent');
        const consent = stored ? JSON.parse(stored)?.consent : null;
        if (consent === 'all') posthog.opt_in_capturing();
      } catch { /* no consent yet — stay opted out */ }
      if (import.meta.env.DEV) {
        console.log('PostHog initialized:', posthog);
      }
    },
    // SPA pageviews: one $pageview on load and one per client-side route change
    // (history.pushState/replaceState). No manual $pageview anywhere else, or
    // every page counts twice.
    capture_pageview: 'history_change',
    // Capture pageleaves automatically
    capture_pageleave: true,
    // Session recording MUST mask everything — this is a CRM/transcript app, so
    // replays would otherwise ship customer emails, phone numbers, and meeting
    // transcript text to a third party.
    session_recording: {
      recordCrossOriginIframes: false,
      maskAllInputs: true,
      maskTextSelector: '*',
    },
    // Disable in development by default (set to true to test)
    disable_session_recording: import.meta.env.DEV,
    // Person profiles
    person_profiles: 'identified_only', // Only create profiles for identified users
    // Exception autocapture. The option was misnamed (enable_exception_autocapture)
    // and silently ignored, so this was never actually on until now.
    capture_exceptions: true,
    // Handle request errors gracefully (including 408 timeouts)
    on_request_error: (response) => {
      // Only log errors in development to avoid console spam
      if (import.meta.env.DEV) {
        // 408 is a timeout - these are often transient network issues
        if (response.statusCode === 408) {
          // Silently ignore timeouts in production, log in dev
          console.debug('PostHog request timeout (408) - request will be retried automatically');
        } else {
          console.warn('PostHog request error:', response.statusCode, response);
        }
      }
      // PostHog automatically retries failed requests, so we don't need to do anything
    },
  });

  return posthog;
};

// True once init() ran with a key. With no key (self-host, local dev) the client
// is never loaded and every call below is skipped, so nothing phones home.
export const posthogReady = () => Boolean((posthog as unknown as { __loaded?: boolean }).__loaded);

// Export PostHog instance for direct use
export { posthog };

