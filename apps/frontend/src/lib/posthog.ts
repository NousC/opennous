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
    // Enable automatic pageview tracking
    loaded: (posthog) => {
      if (import.meta.env.DEV) {
        console.log('PostHog initialized:', posthog);
      }
    },
    // Capture pageviews automatically
    capture_pageview: true,
    // Capture pageleaves automatically
    capture_pageleave: true,
    // Enable session recording (optional - can be disabled for privacy)
    session_recording: {
      recordCrossOriginIframes: false,
    },
    // Disable in development by default (set to true to test)
    disable_session_recording: import.meta.env.DEV,
    // Person profiles
    person_profiles: 'identified_only', // Only create profiles for identified users
    // Enable exception autocapture
    enable_exception_autocapture: true,
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

// Export PostHog instance for direct use
export { posthog };

