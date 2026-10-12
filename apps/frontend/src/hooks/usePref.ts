// Remember each person's choices (standard 3, GET-595).
//
// Board vs list, filters, sort, folded groups: set once, still there next time. One key
// scheme for all of them — `nous.pref.{workspace}.{key}` in localStorage — so a choice made in
// one workspace never leaks into another, and pages stop inventing their own keys. Other tabs
// and other mounts of the same key follow along. A value that can't be read (private window,
// old shape) falls back to the default instead of breaking the page.
//
// A URL that carries the same setting still wins when shared: pages read the URL first and
// fall back to usePref.
import { useCallback, useContext, useEffect, useState } from "react";
import { AuthContext } from "@/contexts/AuthContext";

const EVENT = "nous-pref";
export const prefKey = (ws: string, key: string) => `nous.pref.${ws || "_"}.${key}`;

function read<T>(storageKey: string, fallback: T, valid?: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return fallback;
    const v: unknown = JSON.parse(raw);
    return valid ? (valid(v) ? v : fallback) : (v as T);
  } catch {
    return fallback;
  }
}

export function usePref<T>(
  key: string,
  fallback: T,
  /** Guard for values written by an older build, e.g. (v) => v === "board" || v === "list". */
  valid?: (v: unknown) => v is T,
): [T, (next: T | ((prev: T) => T)) => void] {
  // Read the context directly (not useAuth) so a preference never throws outside the app
  // shell, e.g. in the dev gallery or a preview harness.
  const auth = useContext(AuthContext);
  const ws = (auth?.userData as { workspace?: { id?: string } } | null | undefined)?.workspace?.id ?? "";
  const storageKey = prefKey(ws, key);

  const [value, setValue] = useState<T>(() => read(storageKey, fallback, valid));
  // The workspace arrives after first paint; re-read once it does.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setValue(read(storageKey, fallback, valid)), [storageKey]);

  useEffect(() => {
    const sync = (e: Event) => {
      const k = e instanceof StorageEvent ? e.key : (e as CustomEvent<string>).detail;
      if (k === storageKey) setValue(read(storageKey, fallback, valid));
    };
    window.addEventListener("storage", sync);
    window.addEventListener(EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(EVENT, sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        try {
          localStorage.setItem(storageKey, JSON.stringify(v));
          queueMicrotask(() => window.dispatchEvent(new CustomEvent(EVENT, { detail: storageKey })));
        } catch {
          /* private window: keep it for this session only */
        }
        return v;
      });
    },
    [storageKey],
  );

  return [value, set];
}
