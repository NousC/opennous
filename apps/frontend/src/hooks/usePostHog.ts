import { useEffect, useRef } from 'react';
import { posthog, posthogReady } from '@/lib/posthog';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Hook to use PostHog analytics
 * Identifies the user when they log in, and resets PostHog when the session ends
 * (any sign-out path: Settings, the Clerk widget, an expired session) so the next
 * person on the same browser starts anonymous instead of merging into the last one.
 */
export function usePostHog() {
  const { userData, session } = useAuth();
  const identifiedId = useRef<string | null>(null);

  useEffect(() => {
    if (!posthogReady()) return;
    const user = userData?.user;
    if (user?.id && session) {
      if (identifiedId.current !== user.id) {
        posthog.identify(user.id, {
          email: user.email,
          name: user.name || user.email,
        });
        identifiedId.current = user.id;
      }
    } else if (!session && identifiedId.current) {
      posthog.reset();
      identifiedId.current = null;
    }
  }, [userData, session]);

  return posthog;
}
