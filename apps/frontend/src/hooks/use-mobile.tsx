import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  // Initialize with actual value to prevent hydration mismatch and extra re-renders
  const [isMobile, setIsMobile] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MOBILE_BREAKPOINT;
  });

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    // Only update if different from initial value
    const current = window.innerWidth < MOBILE_BREAKPOINT;
    if (current !== isMobile) {
      setIsMobile(current);
    }
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
