import { useEffect, useState } from "react";

/**
 * The current time, re-read every `everyMs` (a minute by default), so "12m ago" labels
 * move on their own. One shared interval for every subscriber on the page.
 */
const subscribers = new Set<(t: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    subscribers.add(setNow);
    if (!timer) timer = setInterval(() => subscribers.forEach((fn) => fn(Date.now())), everyMs);
    return () => {
      subscribers.delete(setNow);
      if (subscribers.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [everyMs]);
  return now;
}
