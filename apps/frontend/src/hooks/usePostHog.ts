import { useEffect } from 'react';
import { posthog } from '@/lib/posthog';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Hook to use PostHog analytics
 * Automatically identifies users when they log in
 */
export function usePostHog() {
  const { userData, session } = useAuth();

  // Identify user when they log in
  useEffect(() => {
    const user = userData?.user;
    if (user?.id && session && posthog) {
      posthog.identify(user.id, {
        email: user.email,
        name: user.name || user.email,
      });
    }
  }, [userData, session]);

  return posthog;
}

